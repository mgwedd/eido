import {
  chmodSync,
  copyFileSync,
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"

import { applyOwnership, copyDatabase } from "./copy-database.ts"
import { BackupError } from "./errors.ts"
import { openWal, tempDir } from "./test-support.ts"

const count = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(db.prepare("SELECT count(*) AS n FROM t").get()?.["n"])
  } finally {
    db.close()
  }
}

test("the copy holds a write that is still only in the WAL, which a raw file copy misses", () => {
  const dir = tempDir()
  const live = openWal(join(dir, "live.db"))
  live.exec("CREATE TABLE t (x)")
  live.exec("INSERT INTO t VALUES (1)")

  copyFileSync(join(dir, "live.db"), join(dir, "raw.db"))
  copyDatabase(join(dir, "live.db"), join(dir, "copy.db"))

  expect(existsSync(join(dir, "live.db-wal"))).toBe(true)
  expect(count(join(dir, "copy.db"))).toBe(1)
  expect(() => count(join(dir, "raw.db"))).toThrow(/no such table/)
  live.close()
})

test("the live database keeps accepting writes after the copy, and the copy does not change", () => {
  const dir = tempDir()
  const live = openWal(join(dir, "live.db"))
  live.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)")
  copyDatabase(join(dir, "live.db"), join(dir, "copy.db"))
  live.exec("INSERT INTO t VALUES (2)")
  expect(count(join(dir, "live.db"))).toBe(2)
  expect(count(join(dir, "copy.db"))).toBe(1)
  live.close()
})

test("an existing destination is replaced", () => {
  const dir = tempDir()
  const live = openWal(join(dir, "live.db"))
  live.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)")
  writeFileSync(join(dir, "copy.db"), "stale")
  copyDatabase(join(dir, "live.db"), join(dir, "copy.db"))
  expect(count(join(dir, "copy.db"))).toBe(1)
  live.close()
})

test("a missing source is an error and is not created", () => {
  const dir = tempDir()
  expect(() =>
    copyDatabase(join(dir, "nope.db"), join(dir, "copy.db"))
  ).toThrow(BackupError)
  expect(existsSync(join(dir, "nope.db"))).toBe(false)
  expect(existsSync(join(dir, "copy.db"))).toBe(false)
})

test("a source that is not a database fails instead of producing a copy", () => {
  const dir = tempDir()
  writeFileSync(
    join(dir, "bad.db"),
    "this is not sqlite, it is just text padding".repeat(40)
  )
  expect(() =>
    copyDatabase(join(dir, "bad.db"), join(dir, "copy.db"))
  ).toThrow()
})

test("the copy has the source's permission bits, not the writer's default", () => {
  const dir = tempDir()
  const live = openWal(join(dir, "live.db"))
  live.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)")
  chmodSync(join(dir, "live.db"), 0o640)
  copyDatabase(join(dir, "live.db"), join(dir, "copy.db"))
  expect(statSync(join(dir, "copy.db")).mode & 0o777).toBe(0o640)
  live.close()
})

test("applyOwnership hands the copy to the source's owner and group, with the permission bits only", () => {
  const calls: string[] = []
  applyOwnership(
    "/staging/eido-control.db",
    // A regular file owned by uid 451, mode 0600, as the file type bits stat reports.
    { uid: 451, gid: 451, mode: 0o100600 },
    {
      chown: (path, uid, gid) => calls.push(`chown ${path} ${uid}:${gid}`),
      chmod: (path, mode) => calls.push(`chmod ${path} ${mode.toString(8)}`),
    }
  )
  expect(calls).toEqual([
    "chown /staging/eido-control.db 451:451",
    "chmod /staging/eido-control.db 600",
  ])
})
