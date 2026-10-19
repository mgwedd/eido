import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { openControlDb } from "./control-db"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "eido-control-"))
  dirs.push(dir)
  return join(dir, "eido-control.db")
}
const version = (db: DatabaseSync) =>
  Number(db.prepare("PRAGMA user_version").get()?.["user_version"])

describe("openControlDb", () => {
  it("creates the schema, enables foreign keys and WAL", () => {
    const db = openControlDb(tempPath())
    expect(version(db)).toBe(6)
    expect(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"]).toBe(1)
    expect(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe(
      "wal"
    )
    db.close()
  })

  it("does not re-run applied migrations on an existing file", () => {
    const path = tempPath()
    const first = openControlDb(path)
    first.exec(
      "INSERT INTO audit_log (ts, actor, action, target, detail_hash, prev_hash) VALUES ('t','a','b','c','" +
        "0".repeat(64) +
        "','" +
        "0".repeat(64) +
        "')"
    )
    first.close()
    const second = openControlDb(path) // re-running migration 1 would throw "table already exists"
    expect(version(second)).toBe(6)
    expect(
      second.prepare("SELECT COUNT(*) AS n FROM audit_log").get()?.["n"]
    ).toBe(1)
    second.close()
  })

  it("works with :memory:", () => {
    const db = openControlDb(":memory:")
    expect(version(db)).toBe(6)
    db.close()
  })

  it("refuses an approved row without its signature, credential, counter and nonce", () => {
    const db = openControlDb(":memory:")
    expect(() =>
      db.exec(
        "INSERT INTO approvals (intent_id, bundle_hash, decision, decided_at) VALUES ('i', 'h', 'approved', 't')"
      )
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })
})
