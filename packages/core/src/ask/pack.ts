import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { assembleContext, packEntry } from "../context/assemble"
import type { ContextRefusal } from "../context/assemble"
import {
  ESTIMATE_BOUNDARY,
  blockParts,
  packIdFor,
  packParts,
  packText,
  storeContextPack,
} from "../context/pack-store"
import type { ContextPack, PackBlock, PackMember } from "../context/pack-store"
import { COMPACTION_LEGEND } from "../context/compact"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"
import { fence, plainContent, toMaterial } from "../inference/fence"
import { LIVE_DOCUMENT_PREDICATE } from "../index/heads"
import { compareUnits, matchingPassages, termHits } from "./passages"
import type { Passage, RankedUnit } from "./passages"
import type { ZoomItem } from "./zoom"

export interface AskPackArgs {
  /** sha256 of each search hit, best first. The first one seeds the pack. */
  hits: string[]
  budgetTokens: number
  charsPerToken?: number
  /** Set for a focused request: the pack is ranked passages and whole documents, not a thread. */
  focus?: AskFocus
}

export interface AskFocus {
  /** The normalized terms the search matched on, fuzzy variants included. */
  terms: ReadonlySet<string>
  /** Each hit's search score by sha256; a hit without one scores 0. */
  searchScores: ReadonlyMap<string, number>
}

interface FocusDoc {
  sha256: string
  label: string
  title: string
  body: string
  occurredAt: string
  from: string | undefined
  attachment: boolean
}

function focusDoc(db: DatabaseSync, sha256: string): FocusDoc {
  const row = db
    .prepare(
      `SELECT d.source, t.title, t.body, t.occurred_at, t.attachment_of,
         (SELECT address FROM mail_addresses a WHERE a.sha256 = d.sha256 AND a.role = 'from'
          ORDER BY position LIMIT 1) AS sender
       FROM documents d JOIN document_text t ON t.sha256 = d.sha256
       WHERE ${LIVE_DOCUMENT_PREDICATE} AND d.sha256 = ?`
    )
    .get(sha256)
  if (row === undefined) throw new Error("a pack entry is not in the index")
  const text = (value: unknown): string =>
    typeof value === "string" ? value : ""
  const sender = text(row["sender"])
  return {
    sha256,
    label: String(row["source"]),
    title: text(row["title"]),
    body: String(row["body"]),
    occurredAt: text(row["occurred_at"]),
    from: sender === "" ? undefined : sender,
    attachment: text(row["attachment_of"]) !== "",
  }
}

/** The document's selected passages, in body order, as one fenced excerpt under `tag`. */
function excerptEntry(
  doc: FocusDoc,
  passages: readonly Passage[],
  tag: string
): PackBlock {
  const text = passages
    .map((p) => doc.body.slice(p.start, p.end))
    .join("\n[…]\n")
  return {
    tag,
    label: doc.label,
    block: fence(
      toMaterial(`${doc.title} | ${doc.occurredAt}\n${text}`, {
        source: doc.attachment ? "attachment" : "mail",
        part: "excerpt",
        ...(doc.from === undefined ? {} : { from: doc.from }),
      })
    ),
  }
}

const entryTokens = (entry: PackBlock, charsPerToken: number): number =>
  estimateTokens(
    plainContent(blockParts(entry), ESTIMATE_BOUNDARY),
    charsPerToken
  )

const byStart = (a: Passage, b: Passage): number => a.start - b.start

interface Chosen {
  doc: FocusDoc
  /** null: the whole document. */
  passages: Passage[] | null
  tokens: number
}

/**
 * A focused pack: every hit becomes ranked units (the passages that hold a search term, when they
 * are materially smaller than the body, or else the whole document), and units join best first
 * while they fit. A document's passages share one member. The best unit is the seed: if it does
 * not fit, the request is refused, never truncated.
 */
async function buildFocusedPack(
  db: DatabaseSync,
  hits: readonly string[],
  focus: AskFocus,
  budgetTokens: number,
  charsPerToken: number
): Promise<ContextPack | ContextRefusal> {
  const docs = new Map<string, FocusDoc>()
  const units: { unit: RankedUnit; doc: FocusDoc }[] = []
  for (const sha256 of hits) {
    if (docs.has(sha256)) continue
    const doc = focusDoc(db, sha256)
    docs.set(sha256, doc)
    const base = {
      sha256,
      searchScore: focus.searchScores.get(sha256) ?? 0,
      occurredAt: doc.occurredAt,
    }
    const passages = matchingPassages(doc.body, focus.terms)
    if (passages === null)
      units.push({
        unit: { ...base, score: termHits(doc.body, focus.terms) },
        doc,
      })
    else
      for (const passage of passages)
        units.push({
          unit: {
            ...base,
            score: termHits(
              doc.body.slice(passage.start, passage.end),
              focus.terms
            ),
            passage,
          },
          doc,
        })
  }
  units.sort((a, b) => compareUnits(a.unit, b.unit))

  // Estimated with the widest tag any member could get, so the real pack never estimates above.
  const widestTag = `[M${String(docs.size)}]`
  const chosen = new Map<string, Chosen>()
  let used = estimateTokens(COMPACTION_LEGEND, charsPerToken)
  for (const { unit, doc } of units) {
    const previous = chosen.get(unit.sha256)
    const passages =
      unit.passage === undefined
        ? null
        : [...(previous?.passages ?? []), unit.passage].sort(byStart)
    const tokens =
      passages === null
        ? packEntry(db, doc.sha256, widestTag, charsPerToken).member.tokens
        : entryTokens(excerptEntry(doc, passages, widestTag), charsPerToken)
    const added = tokens - (previous?.tokens ?? 0)
    if (used + added > budgetTokens) {
      if (chosen.size === 0)
        return {
          refused: true,
          reason: "seed_too_large",
          seedTokens: used + added,
          budgetTokens,
        }
      continue
    }
    used += added
    chosen.set(unit.sha256, { doc, passages, tokens })
  }

  const blocks: PackBlock[] = []
  const members: PackMember[] = []
  for (const { doc, passages } of chosen.values()) {
    const tag = `[M${String(members.length + 1)}]`
    if (passages === null) {
      const { entry, member } = packEntry(db, doc.sha256, tag, charsPerToken)
      blocks.push(entry)
      members.push(member)
      continue
    }
    const entry = excerptEntry(doc, passages, tag)
    blocks.push(entry)
    members.push({
      tag,
      sha256: doc.sha256,
      edge: "seed",
      tokens: entryTokens(entry, charsPerToken),
      injectionSuspected: entry.block.injectionSuspected,
      injectionReasons: [...entry.block.reasons],
      excerpt: {
        passages: passages.map(({ start, end }) => ({ start, end })),
        omittedChars:
          doc.body.length -
          passages.reduce((sum, p) => sum + p.end - p.start, 0),
      },
    })
  }
  return finishPack(db, blocks, members, docs.size - chosen.size, charsPerToken)
}

/**
 * A pack of the raw items a zoom selected (passages and openings), one excerpt member per
 * document in selection order. Offsets are those of the stored body, as the selector verified them.
 */
export async function buildZoomPack(
  db: DatabaseSync,
  items: readonly ZoomItem[],
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
  store = true
): Promise<ContextPack> {
  const bySha = new Map<string, Passage[]>()
  for (const item of items) {
    if (item.kind === "summary") continue
    const list = bySha.get(item.sha256) ?? []
    list.push({ start: item.start, end: item.end })
    bySha.set(item.sha256, list)
  }
  const blocks: PackBlock[] = []
  const members: PackMember[] = []
  for (const [sha256, list] of bySha) {
    const doc = focusDoc(db, sha256)
    const passages = [...list].sort(byStart)
    const tag = `[M${String(members.length + 1)}]`
    const entry = excerptEntry(doc, passages, tag)
    blocks.push(entry)
    members.push({
      tag,
      sha256,
      edge: "seed",
      tokens: entryTokens(entry, charsPerToken),
      injectionSuspected: entry.block.injectionSuspected,
      injectionReasons: [...entry.block.reasons],
      excerpt: {
        passages,
        omittedChars:
          doc.body.length -
          passages.reduce((sum, p) => sum + p.end - p.start, 0),
      },
    })
  }
  return finishPack(db, blocks, members, 0, charsPerToken, store)
}

async function finishPack(
  db: DatabaseSync,
  blocks: PackBlock[],
  members: PackMember[],
  droppedMembers: number,
  charsPerToken: number,
  store = true
): Promise<ContextPack> {
  const packHash = createHash("sha256")
    .update(packText({ blocks }))
    .digest("hex")
  const pack: ContextPack = {
    id: packIdFor(packHash),
    blocks,
    members,
    tokenCount: estimateTokens(
      plainContent(packParts({ blocks }), ESTIMATE_BOUNDARY),
      charsPerToken
    ),
    droppedMembers,
    packHash,
  }
  if (store) await storeContextPack(db, pack)
  return pack
}

/**
 * The pack for one ask. Broad (no `focus`): `assembleContext` seeded on the top hit (with its
 * reply chain, thread and attachments), extended with the next hits whose blocks fit the
 * remaining budget; hits already in the pack are skipped. Focused: ranked passages and whole
 * documents (see `buildFocusedPack`). A seed that does not fit returns the context refusal.
 */
export async function buildAskPack(
  db: DatabaseSync,
  args: AskPackArgs
): Promise<ContextPack | ContextRefusal> {
  const charsPerToken = args.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const [top, ...rest] = args.hits
  if (top === undefined) throw new Error("an ask pack needs at least one hit")
  if (args.focus !== undefined)
    return buildFocusedPack(
      db,
      args.hits,
      args.focus,
      args.budgetTokens,
      charsPerToken
    )
  const base = await assembleContext(
    db,
    { seed: top, task: "ask", budgetTokens: args.budgetTokens },
    { charsPerToken }
  )
  if ("refused" in base) return base

  const members = [...base.members]
  const blocks = [...base.blocks]
  const included = new Set(members.map((m) => m.sha256))
  let used = base.tokenCount
  for (const hit of rest) {
    if (included.has(hit)) continue
    const tag = `[M${String(members.length + 1)}]`
    const { entry, member } = packEntry(db, hit, tag, charsPerToken)
    if (used + member.tokens > args.budgetTokens) continue
    used += member.tokens
    blocks.push(entry)
    members.push(member)
    included.add(hit)
  }
  if (members.length === base.members.length) return base
  return finishPack(db, blocks, members, base.droppedMembers, charsPerToken)
}
