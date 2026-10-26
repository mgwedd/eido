import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createPrivateWorkDirectory,
  preparePrivateScratchRoot,
} from "./private-scratch"

let parent: string | undefined

afterEach(() => {
  if (parent !== undefined) rmSync(parent, { recursive: true, force: true })
  parent = undefined
})

function makeRoot(): string {
  parent = mkdtempSync(join(tmpdir(), "eido-private-scratch-"))
  return join(parent, "parse-tmp")
}

describe("private parser scratch", () => {
  it("creates a 0700 root and rejects an existing group or world accessible root", () => {
    const root = makeRoot()
    preparePrivateScratchRoot(root, "linux", 10_000_000)
    expect((requireMode(root) & 0o777).toString(8)).toBe("700")

    chmodSync(root, 0o755)
    expect(() => preparePrivateScratchRoot(root, "linux", 10_000_000)).toThrow(
      /group or world access/
    )
  })

  it("removes only stale generated work and preserves active work and unrelated files", () => {
    const root = makeRoot()
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const stale = createPrivateWorkDirectory(root)
    const active = createPrivateWorkDirectory(root)
    const unrelated = join(root, "parse-unrelated")
    mkdirSync(unrelated, { mode: 0o700 })
    writeFileSync(join(root, "keep.txt"), "synthetic")
    const now = 10_000_000
    const old = new Date(now - 25 * 60 * 60 * 1000)
    utimesSync(stale, old, old)

    preparePrivateScratchRoot(root, "linux", now)

    expect(readdirSync(root).sort()).toEqual(
      ["keep.txt", "parse-unrelated", basename(active)].sort()
    )
  })

  it("fails closed on platforms without POSIX private directory modes", () => {
    expect(() => preparePrivateScratchRoot("unused", "win32", 0)).toThrow(
      /unsupported on this platform/
    )
  })

  it.skipIf(process.platform !== "darwin")(
    "sets and verifies the macOS system backup exclusion",
    () => {
      const root = makeRoot()
      preparePrivateScratchRoot(root, "darwin", 10_000_000)
      const value = execFile("/usr/bin/xattr", [
        "-p",
        "com.apple.metadata:com_apple_backup_excludeItem",
        root,
      ])
      expect(value).toBe("com.apple.backupd")
    }
  )
})

function requireMode(path: string): number {
  return statSync(path).mode & 0o777
}

function execFile(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("backup exclusion xattr could not be read")
  }
  return result.stdout.trim()
}
