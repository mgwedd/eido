import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { openIndex } from "../index/schema"
import type { ContextPack } from "./pack-store"
import { packIdFor, readContextPack, storeContextPack } from "./pack-store"

const HASH = "ab".repeat(32)
const PACK: ContextPack = {
  id: packIdFor(HASH),
  blocks: [],
  members: [
    {
      tag: "[M1]",
      sha256: "cd".repeat(32),
      edge: "seed",
      tokens: 4,
      injectionSuspected: true,
      injectionReasons: ["fence-tag", "hidden-characters"],
    },
  ],
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

  test("storing the same pack twice adds one row", async () => {
    expect(await storeContextPack(db, PACK)).toBe(true)
    expect(await storeContextPack(db, PACK)).toBe(false)
    expect(readContextPack(db, PACK.id)?.members).toEqual(PACK.members)
  })

  test("an unknown id reads as null", () => {
    expect(readContextPack(db, "cp_missing")).toBeNull()
  })

  test("reading without the table does not create schema", () => {
    expect(readContextPack(db, PACK.id)).toBeNull()
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_packs'"
        )
        .get()
    ).toBeUndefined()
  })

  test("malformed stored members are rejected, not cast", async () => {
    await storeContextPack(db, PACK)
    insertRaw("a", "{}")
    insertRaw("b", "[1]")
    insertRaw(
      "c",
      '[{"tag":"[M1]","sha256":"x","edge":"cousin","tokens":1,"injectionSuspected":false,"injectionReasons":[]}]'
    )
    insertRaw(
      "d",
      '[{"tag":"[M1]","sha256":"x","edge":"seed","tokens":1,"injectionSuspected":"no","injectionReasons":[]}]'
    )
    insertRaw(
      "e",
      '[{"tag":"[M1]","sha256":"x","edge":"seed","tokens":1,"injectionSuspected":true,"injectionReasons":["made-up"]}]'
    )
    expect(() => readContextPack(db, "a")).toThrow("not a list")
    expect(() => readContextPack(db, "b")).toThrow("not an object")
    expect(() => readContextPack(db, "c")).toThrow("malformed field")
    expect(() => readContextPack(db, "d")).toThrow("malformed field")
    expect(() => readContextPack(db, "e")).toThrow("malformed field")
    // An excerpt that is not an object, has no passages, a negative omitted count, an empty or
    // fractional range, or a passage that is not an object.
    insertRaw(
      "f",
      '[{"tag":"[M1]","sha256":"x","edge":"seed","tokens":1,"injectionSuspected":false,"injectionReasons":[],"excerpt":"some"}]'
    )
    insertRaw(
      "g",
      '[{"tag":"[M1]","sha256":"x","edge":"seed","tokens":1,"injectionSuspected":false,"injectionReasons":[],"excerpt":{"passages":[],"omittedChars":0}}]'
    )
    insertRaw(
      "h",
      '[{"tag":"[M1]","sha256":"x","edge":"seed","tokens":1,"injectionSuspected":false,"injectionReasons":[],"excerpt":{"passages":[{"start":0,"end":5}],"omittedChars":-1}}]'
    )
    insertRaw(
      "i",
      '[{"tag":"[M1]","sha256":"x","edge":"seed","tokens":1,"injectionSuspected":false,"injectionReasons":[],"excerpt":{"passages":[{"start":5,"end":5}],"omittedChars":0}}]'
    )
    insertRaw(
      "j",
      '[{"tag":"[M1]","sha256":"x","edge":"seed","tokens":1,"injectionSuspected":false,"injectionReasons":[],"excerpt":{"passages":[{"start":0.5,"end":5}],"omittedChars":0}}]'
    )
    insertRaw(
      "k",
      '[{"tag":"[M1]","sha256":"x","edge":"seed","tokens":1,"injectionSuspected":false,"injectionReasons":[],"excerpt":{"passages":[7],"omittedChars":0}}]'
    )
    expect(() => readContextPack(db, "f")).toThrow("malformed field")
    expect(() => readContextPack(db, "g")).toThrow("malformed field")
    expect(() => readContextPack(db, "h")).toThrow("malformed field")
    expect(() => readContextPack(db, "i")).toThrow("malformed field")
    expect(() => readContextPack(db, "j")).toThrow("malformed field")
    expect(() => readContextPack(db, "k")).toThrow("malformed field")
  })
})
