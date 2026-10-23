import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { openIndex } from "../index/schema"
import type { ContextPack } from "./pack-store"
import { packIdFor, readContextPack, storeContextPack } from "./pack-store"

const HASH = "ab".repeat(32)
const PACK: ContextPack = {
  id: packIdFor(HASH),
  text: "Format: x",
  members: [{ tag: "[M1]", sha256: "cd".repeat(32), edge: "seed", tokens: 4 }],
  tokenCount: 4,
  droppedMembers: 0,
  packHash: HASH,
}

let db: DatabaseSync
beforeEach(() => {
  db = openIndex(":memory:")
})

const insertRaw = (id: string, membersJson: string) =>
  db
    .prepare(
      "INSERT INTO context_packs (id, members_json, token_count, pack_hash) VALUES (?, ?, 1, 'h')"
    )
    .run(id, membersJson)

describe("context pack store", () => {
  test("the id is derived from the hash", () => {
    expect(packIdFor(HASH)).toBe(`cp_${"ab".repeat(16)}`)
  })

  test("storing the same pack twice adds one row", () => {
    expect(storeContextPack(db, PACK)).toBe(true)
    expect(storeContextPack(db, PACK)).toBe(false)
    expect(readContextPack(db, PACK.id)?.members).toEqual(PACK.members)
  })

  test("an unknown id reads as null", () => {
    expect(readContextPack(db, "cp_missing")).toBeNull()
  })

  test("malformed stored members are rejected, not cast", () => {
    storeContextPack(db, PACK)
    insertRaw("a", "{}")
    insertRaw("b", "[1]")
    insertRaw("c", '[{"tag":"[M1]","sha256":"x","edge":"cousin","tokens":1}]')
    expect(() => readContextPack(db, "a")).toThrow("not a list")
    expect(() => readContextPack(db, "b")).toThrow("not an object")
    expect(() => readContextPack(db, "c")).toThrow("malformed field")
  })
})
