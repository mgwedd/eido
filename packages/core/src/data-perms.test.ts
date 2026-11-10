import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { secureDataDir, secureDataFiles } from "./data-perms"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eido-perms-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const mode = (path: string): number => statSync(path).mode & 0o777

it("tightens an existing data dir that was group- and world-readable", () => {
  const dir = join(root, "data")
  mkdirSync(dir, { mode: 0o755 })
  chmodSync(dir, 0o755)
  secureDataDir(dir)
  expect(mode(dir)).toBe(0o700)
})

it("creates a missing data dir as 0700", () => {
  const dir = join(root, "a", "b")
  secureDataDir(dir)
  expect(mode(dir)).toBe(0o700)
})

it("sets 0600 on existing database files and sidecars, and creates a missing one as 0600", () => {
  const db = join(root, "x.db")
  writeFileSync(db, "", { mode: 0o644 })
  chmodSync(db, 0o644)
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    writeFileSync(`${db}${suffix}`, "")
    chmodSync(`${db}${suffix}`, 0o666)
  }
  const fresh = join(root, "fresh.db")
  secureDataFiles([db, fresh])
  expect(
    ["", "-wal", "-shm", "-journal"].map((s) => mode(`${db}${s}`))
  ).toEqual([0o600, 0o600, 0o600, 0o600])
  expect(mode(fresh)).toBe(0o600)
})
