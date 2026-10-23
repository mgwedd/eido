import type { DatabaseSync } from "node:sqlite"

export type MemberEdge = "seed" | "reply" | "thread" | "attachment"

export interface PackMember {
  tag: string
  sha256: string
  edge: MemberEdge
  tokens: number
}

export interface ContextPack {
  id: string
  text: string
  members: PackMember[]
  tokenCount: number
  droppedMembers: number
  packHash: string
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

function parseMember(value: unknown): PackMember {
  if (typeof value !== "object" || value === null)
    throw new Error("context pack member is not an object")
  const tag: unknown = Reflect.get(value, "tag")
  const sha256: unknown = Reflect.get(value, "sha256")
  const edge: unknown = Reflect.get(value, "edge")
  const tokens: unknown = Reflect.get(value, "tokens")
  if (
    typeof tag !== "string" ||
    typeof sha256 !== "string" ||
    typeof tokens !== "number" ||
    !isEdge(edge)
  )
    throw new Error("context pack member has a malformed field")
  return { tag, sha256, edge, tokens }
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
