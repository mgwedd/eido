import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { append, verifyChain } from "./audit"
import { openControlDb } from "./control-db"

const EMPTY = createHash("sha256").update("").digest("hex")
const dirs: string[] = []
const open: DatabaseSync[] = []
afterEach(() => {
  // Windows cannot remove a file SQLite still holds open, so close every handle first.
  for (const db of open.splice(0)) db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function fileDb(): { db: DatabaseSync; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "eido-audit-"))
  dirs.push(dir)
  const path = join(dir, "eido-control.db")
  const db = openControlDb(path)
  open.push(db)
  return { db, path }
}
function add(db: DatabaseSync, n: number) {
  let last = { seq: 0, rowHash: "" }
  for (let i = 0; i < n; i++) {
    last = append(db, {
      actor: "system",
      action: "test.event",
      target: `id-${i + 1}`,
      detailHash: EMPTY,
    })
  }
  return last
}
function tamper(path: string, sql: string) {
  const raw = new DatabaseSync(path)
  raw.exec("DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete")
  raw.exec(sql)
  raw.close()
}

describe("audit chain", () => {
  it("verifies an empty log", () => {
    expect(verifyChain(openControlDb(":memory:"))).toEqual({
      ok: true,
      rows: 0,
    })
  })

  it("verifies 100 appended rows with sequential seq", () => {
    const db = openControlDb(":memory:")
    expect(add(db, 100).seq).toBe(100)
    expect(verifyChain(db)).toEqual({ ok: true, rows: 100 })
  })

  it("uses the given ts", () => {
    const db = openControlDb(":memory:")
    append(db, {
      actor: "a",
      action: "b",
      target: "c",
      detailHash: EMPTY,
      ts: "2026-01-01T00:00:00.000Z",
    })
    expect(db.prepare("SELECT ts FROM audit_log").get()?.["ts"]).toBe(
      "2026-01-01T00:00:00.000Z"
    )
  })

  it("detects an edited middle row at the row after it", () => {
    const { db, path } = fileDb()
    add(db, 10)
    tamper(path, "UPDATE audit_log SET target = 'evil' WHERE seq = 5")
    expect(verifyChain(db)).toEqual({
      ok: false,
      brokenAtSeq: 6,
      reason: "prev_hash_mismatch",
    })
  })

  it("detects a deleted middle row as seq_gap", () => {
    const { db, path } = fileDb()
    add(db, 10)
    tamper(path, "DELETE FROM audit_log WHERE seq = 5")
    expect(verifyChain(db)).toEqual({
      ok: false,
      brokenAtSeq: 6,
      reason: "seq_gap",
    })
  })

  it("detects a bad genesis", () => {
    const { db, path } = fileDb()
    add(db, 3)
    tamper(
      path,
      "UPDATE audit_log SET prev_hash = '" + "1".repeat(64) + "' WHERE seq = 1"
    )
    expect(verifyChain(db)).toEqual({
      ok: false,
      brokenAtSeq: 1,
      reason: "bad_genesis",
    })
  })

  it("blocks UPDATE and DELETE and leaves the chain valid", () => {
    const db = openControlDb(":memory:")
    add(db, 5)
    expect(() => db.exec("UPDATE audit_log SET target = 'x'")).toThrow(
      /append-only/
    )
    expect(() => db.exec("DELETE FROM audit_log")).toThrow(/append-only/)
    expect(verifyChain(db)).toEqual({ ok: true, rows: 5 })
  })

  it("commits with the caller's transaction", () => {
    const db = openControlDb(":memory:")
    db.exec("BEGIN")
    add(db, 3)
    db.exec("COMMIT")
    expect(verifyChain(db)).toEqual({ ok: true, rows: 3 })
  })

  it("rolls back with the caller's transaction", () => {
    const db = openControlDb(":memory:")
    add(db, 2)
    db.exec("BEGIN")
    add(db, 3)
    db.exec("ROLLBACK")
    expect(verifyChain(db)).toEqual({ ok: true, rows: 2 })
    expect(add(db, 1).seq).toBe(3)
  })

  it("rolls back only its own savepoint when the insert fails inside a caller transaction", () => {
    const db = openControlDb(":memory:")
    add(db, 1)
    db.exec("BEGIN")
    db.exec("DROP TABLE audit_log")
    expect(() => add(db, 1)).toThrow()
    db.exec("ROLLBACK")
    expect(verifyChain(db)).toEqual({ ok: true, rows: 1 })
  })

  it("leaves no row when a standalone append fails", () => {
    const db = openControlDb(":memory:")
    add(db, 1)
    db.exec("ALTER TABLE audit_log RENAME TO audit_old")
    expect(() => add(db, 1)).toThrow()
    expect(db.isTransaction).toBe(false)
  })

  it("checks expectedHead", () => {
    const { db, path } = fileDb()
    const head = add(db, 5)
    expect(verifyChain(db, { expectedHead: head.rowHash })).toEqual({
      ok: true,
      rows: 5,
    })
    expect(verifyChain(db, { expectedHead: "f".repeat(64) })).toEqual({
      ok: false,
      brokenAtSeq: 5,
      reason: "head_mismatch",
    })
    tamper(path, "UPDATE audit_log SET target = 'evil' WHERE seq = 5")
    expect(verifyChain(db)).toEqual({ ok: true, rows: 5 }) // last row is invisible without a head
    expect(verifyChain(db, { expectedHead: head.rowHash })).toMatchObject({
      ok: false,
      reason: "head_mismatch",
    })
  })

  it("rejects detailHash that is not 64 lowercase hex", () => {
    const db = openControlDb(":memory:")
    for (const bad of [
      "",
      "abc",
      "A".repeat(64),
      "g".repeat(64),
      EMPTY + "0",
    ]) {
      expect(() =>
        append(db, { actor: "a", action: "b", target: "c", detailHash: bad })
      ).toThrow(/detailHash/)
    }
    expect(verifyChain(db)).toEqual({ ok: true, rows: 0 })
  })
})
