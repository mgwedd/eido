// A consistent copy of a live SQLite database. `VACUUM INTO` reads one snapshot of the database
// inside a read transaction, WAL contents included, so the writers keep running and the copy is
// a whole database. A raw file copy of a WAL database can miss committed rows or tear.
import { chmodSync, chownSync, existsSync, rmSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { BackupError } from "./errors.ts"

const BUSY_TIMEOUT_MS = 10_000

/** The one `PRAGMA integrity_check` result column, or the first problem it reports. */
export function integrityCheck(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA integrity_check").get()
  return String(row?.["integrity_check"])
}

export type Ownership = { uid: number; gid: number; mode: number }

/**
 * Gives `dest` the owner, group and permission bits in `own`. VACUUM INTO writes the copy as
 * the user running the backup; on a split host that is root, and the snapshot would record a
 * root-owned file where the gate's or data plane's database belongs. restic stores each file's
 * owner and mode, so a root restore puts the file back as its service user owns it.
 */
export function applyOwnership(
  dest: string,
  own: Ownership,
  ops: {
    chown: (path: string, uid: number, gid: number) => void
    chmod: (path: string, mode: number) => void
  } = { chown: chownSync, chmod: chmodSync }
): void {
  ops.chown(dest, own.uid, own.gid)
  ops.chmod(dest, own.mode & 0o7777)
}

/**
 * Copies `source` to `dest` and checks the copy. Never creates `source`: a missing database
 * is an error, not an empty copy. Replaces an existing `dest`. The copy keeps the source's
 * owner, group and mode.
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
  const { uid, gid, mode } = statSync(source)
  const own = statSync(dest)
  // A user who does not own the source cannot hand the copy to it; they never need to either.
  if (own.uid !== uid || own.gid !== gid)
    applyOwnership(dest, { uid, gid, mode })
  else chmodSync(dest, mode & 0o7777)
}
