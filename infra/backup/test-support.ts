// Helpers for the backup tests: synthetic data in temp directories, never real personal data.
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { BackupConfig } from "./config.ts"

export const tempDir = () => mkdtempSync(join(tmpdir(), "eido-backup-test-"))

/** A config whose data, staging, log and repository paths are all under `root`. */
export function testConfig(root: string): BackupConfig {
  const stagingDir = join(root, "stack", "backup-staging")
  const db = (name: string, dir: string) => ({
    name,
    path: join(root, dir, name),
    staged: join(stagingDir, name),
  })
  return {
    databases: [db("eido-data.db", "core"), db("eido-control.db", "gate")],
    blobDir: join(root, "core", "blobs"),
    stagingDir,
    repository: join(root, "drive", "restic"),
    logDir: join(root, "logs"),
    stampFile: join(root, "logs", "backup-last-success"),
  }
}

/** A WAL-mode database that never checkpoints on its own, so its recent writes stay in the -wal file. */
export function openWal(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA wal_autocheckpoint = 0")
  return db
}

export const AUDIT_TABLE =
  "CREATE TABLE audit_log (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_hash TEXT NOT NULL, prev_hash TEXT NOT NULL)"

/** The two-row audit chain whose hashes were computed independently of the code under test. */
export const CHAIN_ROW_1 = [
  1,
  "2026-01-01T00:00:00.000Z",
  "gate",
  "intent.approve",
  "intent-1",
  "a".repeat(64),
  "0".repeat(64),
] as const
export const CHAIN_ROW_2 = [
  2,
  "2026-01-01T00:00:01.000Z",
  "gate",
  "intent.execute",
  "intent-1",
  "b".repeat(64),
  "050f3db3b4c6a448d44237b28091446f0141aa8c0999397660ea923eb52a1464",
] as const

export function insertAudit(
  db: DatabaseSync,
  row: readonly (string | number)[]
): void {
  db.prepare(
    "INSERT INTO audit_log (seq, ts, actor, action, target, detail_hash, prev_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(...row)
}

/** Writes `bytes` at `<blobDir>/<xx>/<sha256>` and returns the path. */
export function writeBlob(blobDir: string, bytes: string): string {
  const hash = createHash("sha256").update(bytes).digest("hex")
  const path = join(blobDir, hash.slice(0, 2), hash)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

/** Builds what a restore leaves under `root`: both databases and two blobs at their configured absolute paths. */
export function materializeRestore(config: BackupConfig, root: string): void {
  for (const spec of config.databases) {
    const path = join(root, spec.staged)
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE t (x TEXT)")
    if (spec.name === "eido-control.db") {
      db.exec(AUDIT_TABLE)
      insertAudit(db, CHAIN_ROW_1)
      insertAudit(db, CHAIN_ROW_2)
    }
    db.close()
  }
  writeBlob(join(root, config.blobDir), "first synthetic original")
  writeBlob(join(root, config.blobDir), "second synthetic original")
}
