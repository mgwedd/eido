// A consistent copy of a live SQLite database. `VACUUM INTO` reads one snapshot of the database
// inside a read transaction, WAL contents included, so the writers keep running and the copy is
// a whole database. A raw file copy of a WAL database can miss committed rows or tear.
import { existsSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { BackupError } from "./errors.ts"

const BUSY_TIMEOUT_MS = 10_000

/** The one `PRAGMA integrity_check` result column, or the first problem it reports. */
export function integrityCheck(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA integrity_check").get()
  return String(row?.["integrity_check"])
}

/**
 * Copies `source` to `dest` and checks the copy. Never creates `source`: a missing database
 * is an error, not an empty copy. Replaces an existing `dest`.
 */
export function copyDatabase(source: string, dest: string): void {
  if (!existsSync(source))
    throw new BackupError(`database not found: ${source}`)
  rmSync(dest, { force: true })
  const live = new DatabaseSync(source, {
    readOnly: true,
    timeout: BUSY_TIMEOUT_MS,
  })
  try {
    live.prepare("VACUUM INTO ?").run(dest)
  } finally {
    live.close()
  }
  const copy = new DatabaseSync(dest, { readOnly: true })
  try {
    const result = integrityCheck(copy)
    if (result !== "ok")
      throw new BackupError(
        `the copy of ${source} failed integrity_check: ${result}`
      )
  } finally {
    copy.close()
  }
}
