import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"
import { fence, plainContent, toMaterial } from "../inference/fence"
import { COMPACTION_LEGEND, compactMessage } from "./compact"
import {
  type ContextPack,
  ESTIMATE_BOUNDARY,
  type MemberEdge,
  type PackBlock,
  type PackMember,
  blockParts,
  packIdFor,
  packParts,
  packText,
  storeContextPack,
} from "./pack-store"
import type { TaskType } from "./tools"

export interface ContextRefusal {
  refused: true
  reason: "seed_too_large"
  seedTokens: number
  budgetTokens: number
}

export interface AssembleArgs {
  /** sha256 of the triggering document. */
  seed: string
  /** The task the pack is for; the caller takes `budgetTokens` from `ContextBudgets[task]`. */
  task: TaskType
  budgetTokens: number
}

export interface AssembleOptions {
  /** Characters per estimated token, as configured for the model client. */
  charsPerToken?: number
}

const MAX_DEPTH = 2
type NeighbourEdge = Exclude<MemberEdge, "seed">
const EDGE_RANK: Record<NeighbourEdge, number> = {
  reply: 0,
  thread: 1,
  attachment: 2,
}

interface Doc {
  sha256: string
  source: string
  sourceRef: string
  title: string
  body: string
  occurredAt: string
  messageId: string | undefined
  inReplyTo: string | undefined
  references: string[]
  threadId: string | undefined
  attachmentOf: string | undefined
}

interface Chosen {
  doc: Doc
  edge: MemberEdge
  entry: PackBlock
  tokens: number
}

interface Neighbour {
  doc: Doc
  edge: NeighbourEdge
}

const SELECT_DOC = `SELECT d.sha256, d.source, d.source_ref, t.title, t.body, t.occurred_at, t.message_id,
  t.in_reply_to, t.references_json, t.thread_id, t.attachment_of
  FROM documents d JOIN document_text t ON t.sha256 = d.sha256`

const optional = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

function parseReferences(value: unknown): string[] {
  if (typeof value !== "string") return []
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed)
    ? parsed.filter((r): r is string => typeof r === "string" && r !== "")
    : []
}

function toDoc(row: Record<string, unknown>): Doc {
  return {
    sha256: String(row["sha256"]),
    source: String(row["source"]),
    sourceRef: String(row["source_ref"]),
    title: optional(row["title"]) ?? "",
    body: String(row["body"]),
    occurredAt: optional(row["occurred_at"]) ?? "",
    messageId: optional(row["message_id"]),
    inReplyTo: optional(row["in_reply_to"]),
    references: parseReferences(row["references_json"]),
    threadId: optional(row["thread_id"]),
    attachmentOf: optional(row["attachment_of"]),
  }
}

const present = (values: (string | undefined)[]): string =>
  JSON.stringify([
    ...new Set(values.filter((v): v is string => v !== undefined)),
  ])

/** Documents one header edge away from any frontier document, excluding those already visited. */
function neighbours(
  db: DatabaseSync,
  frontier: Doc[],
  visited: Set<string>
): Doc[] {
  const list = "(SELECT value FROM json_each(?))"
  const msgIds = present(frontier.map((d) => d.messageId))
  return db
    .prepare(
      `${SELECT_DOC} WHERE d.sha256 NOT IN ${list} AND (
        t.message_id IN ${list}
        OR t.in_reply_to IN ${list}
        OR EXISTS (SELECT 1 FROM json_each(t.references_json) r WHERE r.value IN ${list})
        OR t.thread_id IN ${list}
        OR t.attachment_of IN ${list}
        OR d.source_ref IN ${list}
      )`
    )
    .all(
      JSON.stringify([...visited]),
      present(frontier.flatMap((d) => [d.inReplyTo, ...d.references])),
      msgIds,
      msgIds,
      present(frontier.map((d) => d.threadId)),
      present(frontier.map((d) => d.sourceRef)),
      present(frontier.map((d) => d.attachmentOf))
    )
    .map(toDoc)
}

/** The strongest edge between a document and any frontier document. */
function edgeTo(doc: Doc, frontier: Doc[]): NeighbourEdge {
  let best: NeighbourEdge = "attachment"
  for (const f of frontier) {
    const reply =
      (doc.messageId !== undefined &&
        (doc.messageId === f.inReplyTo ||
          f.references.includes(doc.messageId))) ||
      (f.messageId !== undefined &&
        (doc.inReplyTo === f.messageId || doc.references.includes(f.messageId)))
    if (reply) return "reply"
    if (doc.threadId !== undefined && doc.threadId === f.threadId)
      best = "thread"
  }
  return best
}

/** Walk header edges (reply chain, thread, attachments) from the seed, to depth 2. */
function walk(db: DatabaseSync, seed: Doc): Neighbour[] {
  const visited = new Set([seed.sha256])
  const found: Neighbour[] = []
  let frontier = [seed]
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next = neighbours(db, frontier, visited)
    for (const doc of next) {
      visited.add(doc.sha256)
      found.push({ doc, edge: edgeTo(doc, frontier) })
    }
    frontier = next
  }
  return found
}

function addresses(db: DatabaseSync, sha256: string, role: string): string[] {
  return db
    .prepare(
      "SELECT address FROM mail_addresses WHERE sha256 = ? AND role = ? ORDER BY position"
    )
    .all(sha256, role)
    .map((r) => String(r["address"]))
}

/** The member's text as the model and the owner read it: compacted, then normalized. */
function memberBody(db: DatabaseSync, doc: Doc): string {
  if (doc.attachmentOf !== undefined)
    return `${doc.title} | ${doc.occurredAt}\n${doc.body}`
  return compactMessage({
    from: addresses(db, doc.sha256, "from").join(", "),
    to: addresses(db, doc.sha256, "to"),
    date: doc.occurredAt,
    subject: doc.title,
    body: doc.body,
  }).text
}

/** Every indexed document came from a connector, so it was written by someone else: fenced. */
function entryFor(db: DatabaseSync, doc: Doc, tag: string): PackBlock {
  const source = doc.attachmentOf === undefined ? "mail" : "attachment"
  return {
    tag,
    label: doc.source,
    block: fence(toMaterial(memberBody(db, doc), { source })),
  }
}

const entryTokens = (entry: PackBlock, charsPerToken: number): number =>
  estimateTokens(
    plainContent(blockParts(entry), ESTIMATE_BOUNDARY),
    charsPerToken
  )

function memberOf(
  entry: PackBlock,
  sha256: string,
  edge: MemberEdge,
  tokens: number
): PackMember {
  return {
    tag: entry.tag,
    sha256,
    edge,
    tokens,
    injectionSuspected: entry.block.injectionSuspected,
    injectionReasons: [...entry.block.reasons],
  }
}

/**
 * One indexed document as a pack entry under `tag`, with its estimated tokens: what `buildAskPack`
 * adds for a search hit outside the seed's thread.
 */
export function packEntry(
  db: DatabaseSync,
  sha256: string,
  tag: string,
  charsPerToken: number
): { entry: PackBlock; member: PackMember } {
  const row = db.prepare(`${SELECT_DOC} WHERE d.sha256 = ?`).get(sha256)
  if (row === undefined) throw new Error("a pack entry is not in the index")
  const entry = entryFor(db, toDoc(row), tag)
  const tokens = entryTokens(entry, charsPerToken)
  return { entry, member: memberOf(entry, sha256, "seed", tokens) }
}

const byDateThenSha = (a: Doc, b: Doc): number =>
  a.occurredAt < b.occurredAt
    ? -1
    : a.occurredAt > b.occurredAt
      ? 1
      : a.sha256 < b.sha256
        ? -1
        : 1

/** Rank: edge kind (reply, thread, attachment), then newest first. */
function byRank(a: Neighbour, b: Neighbour): number {
  const edge = EDGE_RANK[a.edge] - EDGE_RANK[b.edge]
  if (edge !== 0) return edge
  return -byDateThenSha(a.doc, b.doc)
}

/**
 * Build the context pack for one request from the seed document and its header edges. Members that
 * do not fit the remaining budget are dropped whole, never truncated. If the seed alone does not
 * fit, nothing is built or stored and a refusal is returned. Never calls the model.
 */
export function assembleContext(
  db: DatabaseSync,
  args: AssembleArgs,
  options: AssembleOptions = {}
): Promise<ContextPack | ContextRefusal> {
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const row = db.prepare(`${SELECT_DOC} WHERE d.sha256 = ?`).get(args.seed)
  if (row === undefined)
    return Promise.reject(new Error("context seed is not in the index"))
  const seed = toDoc(row)

  const neighbours = walk(db, seed).sort(byRank)

  // Each block is estimated with the widest tag any member could get, so the real text never
  // estimates above the sum. The sum of rounded-up parts is never below the whole's estimate.
  const widestTag = `[M${neighbours.length + 1}]`
  const legendTokens = estimateTokens(COMPACTION_LEGEND, charsPerToken)
  const block = (doc: Doc, edge: MemberEdge): Chosen => {
    const entry = entryFor(db, doc, widestTag)
    return { doc, edge, entry, tokens: entryTokens(entry, charsPerToken) }
  }

  const seedBlock = block(seed, "seed")
  const seedTokens = legendTokens + seedBlock.tokens
  if (seedTokens > args.budgetTokens) {
    return Promise.resolve({
      refused: true,
      reason: "seed_too_large",
      seedTokens,
      budgetTokens: args.budgetTokens,
    })
  }

  let used = seedTokens
  const chosen = [seedBlock]
  for (const { doc, edge } of neighbours) {
    const next = block(doc, edge)
    if (used + next.tokens > args.budgetTokens) continue
    used += next.tokens
    chosen.push(next)
  }

  chosen.sort((a, b) => byDateThenSha(a.doc, b.doc))
  const blocks: PackBlock[] = []
  const members: PackMember[] = []
  for (const [i, { doc, edge, entry, tokens }] of chosen.entries()) {
    const tagged = { ...entry, tag: `[M${i + 1}]` }
    blocks.push(tagged)
    members.push(memberOf(tagged, doc.sha256, edge, tokens))
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
    droppedMembers: neighbours.length + 1 - chosen.length,
    packHash,
  }
  storeContextPack(db, pack)
  return Promise.resolve(pack)
}
