import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { assembleContext, packEntry } from "../context/assemble"
import type { ContextRefusal } from "../context/assemble"
import {
  ESTIMATE_BOUNDARY,
  packIdFor,
  packParts,
  packText,
  storeContextPack,
} from "../context/pack-store"
import type { ContextPack } from "../context/pack-store"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"
import { fence, plainContent, toMaterial } from "../inference/fence"
import { tokenize } from "../index/text"
import { COMPACTION_LEGEND } from "../context/compact"

export interface AskPackArgs {
  /** sha256 of each search hit, best first. The first one seeds the pack. */
  hits: string[]
  budgetTokens: number
  charsPerToken?: number
  /** Focused requests may use ranked body passages from long documents. */
  focused?: boolean
  terms?: string[]
  searchScores?: { sha256: string; score: number }[]
}

interface Passage {
  sha256: string
  source: string
  sourceRef: string
  title: string
  occurredAt: string
  body: string
  start: number
  end: number
  score: number
  searchScore: number
  full: boolean
}

function passageCandidates(
  db: DatabaseSync,
  hits: string[],
  terms: string[],
  searchScores: Map<string, number>
): Passage[] {
  const wanted = new Set(terms.map((term) => term.toLocaleLowerCase()))
  const candidates: Passage[] = []
  for (const sha256 of hits) {
    const row = db
      .prepare(
        `SELECT d.source, d.source_ref, t.title, t.body, t.occurred_at
         FROM documents d JOIN document_text t ON t.sha256 = d.sha256 WHERE d.sha256 = ?`
      )
      .get(sha256)
    if (row === undefined) continue
    const body = String(row["body"])
    const paragraphs: { start: number; end: number; text: string }[] = []
    const paragraphPattern = /[^\n]+(?:\n(?!\n)[^\n]+)*/gu
    for (const match of body.matchAll(paragraphPattern)) {
      const text = match[0]
      const start = match.index
      const end = start + text.length
      const matches = tokenize(text).filter((term) => wanted.has(term)).length
      if (matches > 0) paragraphs.push({ start, end, text })
    }
    const matchingLength = paragraphs.reduce(
      (total, paragraph) => total + paragraph.text.length,
      0
    )
    const usePassages =
      paragraphs.length > 0 &&
      body.length >= 1200 &&
      matchingLength * 2 < body.length
    const selected = usePassages
      ? paragraphs
      : [{ start: 0, end: body.length, text: body }]
    for (const paragraph of selected) {
      const words = tokenize(paragraph.text)
      const score = words.reduce(
        (total, word) => total + (wanted.has(word) ? 1 : 0),
        0
      )
      candidates.push({
        sha256,
        source: String(row["source"]),
        sourceRef: String(row["source_ref"]),
        title: String(row["title"] ?? ""),
        occurredAt: String(row["occurred_at"] ?? ""),
        body: paragraph.text,
        start: paragraph.start,
        end: paragraph.end,
        score,
        searchScore: searchScores.get(sha256) ?? 0,
        full: !usePassages,
      })
    }
  }
  return candidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.searchScore - a.searchScore ||
      (a.occurredAt < b.occurredAt
        ? 1
        : a.occurredAt > b.occurredAt
          ? -1
          : 0) ||
      (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0) ||
      a.start - b.start ||
      a.end - b.end
  )
}

function buildFocusedPack(
  db: DatabaseSync,
  hits: string[],
  terms: string[],
  searchScores: Map<string, number>,
  budgetTokens: number,
  charsPerToken: number
): ContextPack | ContextRefusal {
  const passages = passageCandidates(db, hits, terms, searchScores)
  const blocks: ContextPack["blocks"] = []
  const members: ContextPack["members"] = []
  const includedFull = new Set<string>()
  let used = estimateTokens(COMPACTION_LEGEND, charsPerToken)
  for (const passage of passages) {
    if (passage.full && includedFull.has(passage.sha256)) continue
    const tag = `[M${String(members.length + 1)}]`
    const label = passage.source
    const source =
      passage.source === "gmail" || passage.source === "proton"
        ? "mail"
        : "document"
    const content = passage.full
      ? `${passage.title}\n${passage.body}`
      : `${passage.title}\n${passage.body}`
    const block = fence(toMaterial(content, { source }))
    const entry = { tag, label, block }
    const tokens = estimateTokens(
      plainContent([`\n\n${tag} ${label}\n`, block], "0".repeat(32)),
      charsPerToken
    )
    if (members.length === 0 && used + tokens > budgetTokens) {
      return {
        refused: true,
        reason: "seed_too_large",
        seedTokens: used + tokens,
        budgetTokens,
      }
    }
    if (used + tokens > budgetTokens) continue
    used += tokens
    blocks.push(entry)
    members.push({
      tag,
      sha256: passage.sha256,
      edge: "seed",
      tokens,
      injectionSuspected: block.injectionSuspected,
      injectionReasons: [...block.reasons],
      ...(!passage.full
        ? { passageOffsets: [{ start: passage.start, end: passage.end }] }
        : {}),
    })
    if (passage.full) includedFull.add(passage.sha256)
  }
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
    droppedMembers: passages.length - members.length,
    packHash,
  }
  storeContextPack(db, pack)
  return pack
}

/**
 * The pack for one ask: `assembleContext` seeded on the top hit (with its reply chain, thread
 * and attachments), extended with the next hits whose blocks fit the remaining budget. Hits
 * already in the pack are skipped. A seed that does not fit returns the context refusal.
 */
export async function buildAskPack(
  db: DatabaseSync,
  args: AskPackArgs
): Promise<ContextPack | ContextRefusal> {
  const charsPerToken = args.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const [top, ...rest] = args.hits
  if (top === undefined) throw new Error("an ask pack needs at least one hit")
  if (args.focused && args.terms !== undefined)
    return buildFocusedPack(
      db,
      args.hits,
      args.terms,
      new Map((args.searchScores ?? []).map((hit) => [hit.sha256, hit.score])),
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
    droppedMembers: base.droppedMembers,
    packHash,
  }
  storeContextPack(db, pack)
  return pack
}
