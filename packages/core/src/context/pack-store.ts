import type { DatabaseSync } from "node:sqlite"
import { plainContent } from "../inference/fence"
import type {
  FencedBlock,
  InjectionReason,
  PromptPart,
} from "../inference/fence"
import { COMPACTION_LEGEND } from "./compact"

export type MemberEdge = "seed" | "reply" | "thread" | "attachment"

export interface PackMember {
  tag: string
  sha256: string
  edge: MemberEdge
  tokens: number
  /** From `fence`: the member's text looked like an injection attempt. It is still sent. */
  injectionSuspected: boolean
  injectionReasons: InjectionReason[]
}

/** One member's place in the prompt: its tag line (trusted, from the index) and its block. */
export interface PackBlock {
  tag: string
  /** The connector the document came from, from the index. */
  label: string
  block: FencedBlock
}

export interface ContextPack {
  id: string
  /** One per member, in the same order. */
  blocks: PackBlock[]
  members: PackMember[]
  tokenCount: number
  droppedMembers: number
  packHash: string
}

export { ESTIMATE_BOUNDARY } from "../inference/fence"

/** A member's tag line and block as they follow the previous text in the prompt. */
export function blockParts(entry: PackBlock): PromptPart[] {
  return [`\n\n${entry.tag} ${entry.label}\n`, entry.block]
}

/** The pack as prompt parts: the legend, then each member's tag line and fenced block. */
export function packParts(pack: Pick<ContextPack, "blocks">): PromptPart[] {
  return [COMPACTION_LEGEND, ...pack.blocks.flatMap(blockParts)]
}

/** The pack's text with a fixed boundary: what its hash is taken over. */
export function packText(pack: Pick<ContextPack, "blocks">): string {
  return plainContent(packParts(pack), "pack")
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  members_json TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  pack_hash TEXT NOT NULL
)`

/** The pack id is derived from its hash, so the same pack always has the same id. */
export function packIdFor(packHash: string): string {
  return `cp_${packHash.slice(0, 32)}`
}

/** Store a pack record. Storing the same pack again is a no-op. Returns whether a row was added. */
export function storeContextPack(db: DatabaseSync, pack: ContextPack): boolean {
  db.exec(CREATE_TABLE)
  const { changes } = db
    .prepare(
      "INSERT OR IGNORE INTO context_packs (id, members_json, token_count, pack_hash) VALUES (?, ?, ?, ?)"
    )
    .run(pack.id, JSON.stringify(pack.members), pack.tokenCount, pack.packHash)
  return Number(changes) > 0
}

function isEdge(value: unknown): value is MemberEdge {
  return (
    value === "seed" ||
    value === "reply" ||
    value === "thread" ||
    value === "attachment"
  )
}

const REASONS: ReadonlySet<unknown> = new Set<InjectionReason>([
  "fence-tag",
  "template-marker",
  "boundary-confusion",
  "hidden-characters",
])

const isReason = (value: unknown): value is InjectionReason =>
  REASONS.has(value)

function parseMember(value: unknown): PackMember {
  if (typeof value !== "object" || value === null)
    throw new Error("context pack member is not an object")
  const tag: unknown = Reflect.get(value, "tag")
  const sha256: unknown = Reflect.get(value, "sha256")
  const edge: unknown = Reflect.get(value, "edge")
  const tokens: unknown = Reflect.get(value, "tokens")
  const suspected: unknown = Reflect.get(value, "injectionSuspected")
  const reasons: unknown = Reflect.get(value, "injectionReasons")
  if (
    typeof tag !== "string" ||
    typeof sha256 !== "string" ||
    typeof tokens !== "number" ||
    !isEdge(edge) ||
    typeof suspected !== "boolean" ||
    !Array.isArray(reasons) ||
    !reasons.every(isReason)
  )
    throw new Error("context pack member has a malformed field")
  return {
    tag,
    sha256,
    edge,
    tokens,
    injectionSuspected: suspected,
    injectionReasons: reasons,
  }
}

/** Read a stored pack record back, or null when no pack has that id. */
export function readContextPack(
  db: DatabaseSync,
  id: string
): {
  id: string
  members: PackMember[]
  tokenCount: number
  packHash: string
} | null {
  db.exec(CREATE_TABLE)
  const row = db
    .prepare(
      "SELECT id, members_json, token_count, pack_hash FROM context_packs WHERE id = ?"
    )
    .get(id)
  if (row === undefined) return null
  const members: unknown = JSON.parse(String(row["members_json"]))
  if (!Array.isArray(members))
    throw new Error("context pack members are not a list")
  return {
    id: String(row["id"]),
    members: members.map(parseMember),
    tokenCount: Number(row["token_count"]),
    packHash: String(row["pack_hash"]),
  }
}
