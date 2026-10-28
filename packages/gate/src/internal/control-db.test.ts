import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { verifyChain } from "./audit"
import { payloadHash } from "./canonical"
import { openControlDb } from "./control-db"
import { MAIL_OPS, auditRows, manifest } from "./test-fixtures"

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
    expect(version(db)).toBe(9)
    const connectorColumns = db
      .prepare("PRAGMA table_info(connectors)")
      .all()
      .map((row) => row["name"])
    expect(connectorColumns).toEqual(
      expect.arrayContaining([
        "next_attempt_at",
        "last_error",
        "probe_started_at",
        "probe_lease_id",
        "health_generation",
      ])
    )
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
    expect(version(second)).toBe(9)
    expect(
      second.prepare("SELECT COUNT(*) AS n FROM audit_log").get()?.["n"]
    ).toBe(1)
    second.close()
  })

  it("works with :memory:", () => {
    const db = openControlDb(":memory:")
    expect(version(db)).toBe(9)
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

  it("disables and audits enabled legacy pins during migration", () => {
    const path = tempPath()
    const legacy = new DatabaseSync(path)
    legacy.exec(`CREATE TABLE audit_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_hash TEXT NOT NULL, prev_hash TEXT NOT NULL);
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TABLE connectors (name TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL, pinned_at TEXT NOT NULL, enabled INTEGER NOT NULL, health TEXT NOT NULL, consecutive_failures INTEGER NOT NULL, drift_json TEXT) STRICT;
      CREATE TABLE intents (id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 5;`)
    const mail = manifest("mail", MAIL_OPS)
    legacy
      .prepare(
        "INSERT INTO connectors (name, manifest_json, manifest_hash, pinned_at, enabled, health, consecutive_failures) VALUES (?, ?, ?, ?, 1, 'healthy', 0)"
      )
      .run(
        mail.name,
        JSON.stringify(mail),
        payloadHash(mail),
        new Date().toISOString()
      )
    legacy.close()

    const upgraded = openControlDb(path)
    expect(version(upgraded)).toBe(9)
    expect(
      upgraded
        .prepare(
          "SELECT enabled, pin_approval_ref_hash FROM connectors WHERE name = ?"
        )
        .get(mail.name)
    ).toMatchObject({ enabled: 0, pin_approval_ref_hash: null })
    expect(auditRows(upgraded)).toEqual([
      expect.objectContaining({
        actor: "system",
        action: "connector.disabled_unsigned",
        target: mail.name,
      }),
    ])
    expect(verifyChain(upgraded).ok).toBe(true)
    upgraded.close()
  })
})
