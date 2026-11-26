import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { fileHelper } from "./file-helper"
import {
  FILE_HELPER_SIZE_LIMIT,
  installFileHelperCopy,
} from "./file-helper-copy"
import type { FileHelperCopy } from "./file-helper-copy"

const posix = process.platform !== "win32"
const BYTES = "synthetic helper bytes"
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

const dirs: string[] = []
const copies: FileHelperCopy[] = []
afterEach(async () => {
  for (const copy of copies.splice(0)) await copy.remove()
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})
/** A private temp tree with a source helper and an empty copy parent. */
function fixture(bytes = BYTES) {
  const base = realpathSync.native(
    mkdtempSync(join(tmpdir(), "eido-file-helper-copy-"))
  )
  dirs.push(base)
  chmodSync(base, 0o700)
  const source = join(base, "eido-file-helper")
  writeFileSync(source, bytes, { mode: 0o700 })
  const parent = join(base, "copies")
  mkdirSync(parent, { mode: 0o700 })
  return { base, source, parent }
}
async function install(f: ReturnType<typeof fixture>, sha256 = sha(BYTES)) {
  const copy = await installFileHelperCopy({ path: f.source, sha256 }, f.parent)
  copies.push(copy)
  return copy
}
const privateDirs = (parent: string) =>
  readdirSync(parent).filter((name) => name.startsWith("eido-file-helper."))
/**
 * Renames a new file with `bytes` and the copy's mode over the copy. The new file exists while
 * the copy does, so it has another inode (Linux reuses a freed inode number at once). Windows
 * refuses to rename over a read-only file, so the copy is made writable first.
 */
function swap(path: string, bytes: string) {
  const next = `${path}.next`
  writeFileSync(next, bytes)
  chmodSync(next, 0o500)
  chmodSync(path, 0o700)
  renameSync(next, path)
}

describe("installing the private copy", () => {
  it("copies the pinned bytes into a new private directory under the parent", async () => {
    const f = fixture()
    const copy = await install(f)
    expect(dirname(dirname(copy.path))).toBe(f.parent)
    expect(basename(dirname(copy.path))).toMatch(
      /^eido-file-helper\.[0-9a-f]{16}$/
    )
    expect(basename(copy.path)).toBe("file-helper")
    expect(readFileSync(copy.path, "utf8")).toBe(BYTES)
    expect(copy.sha256).toBe(sha(BYTES))
    expect(await copy.verified()).toBe(copy.path)
  })

  it.skipIf(!posix)("makes the copy 0500 and its directory 0700", async () => {
    const copy = await install(fixture())
    expect(statSync(copy.path).mode & 0o7777).toBe(0o500)
    expect(statSync(dirname(copy.path)).mode & 0o7777).toBe(0o700)
  })

  it("keeps the source's extension, which Windows runs an executable by", async () => {
    const f = fixture()
    const source = join(f.base, "eido-file-helper.exe")
    writeFileSync(source, BYTES)
    const copy = await installFileHelperCopy(
      { path: source, sha256: sha(BYTES) },
      f.parent
    )
    copies.push(copy)
    expect(basename(copy.path)).toBe("file-helper.exe")
  })

  it("refuses a source that is not the pin, is missing, or has a malformed pin, and copies nothing", async () => {
    const f = fixture()
    await expect(install(f, sha("other bytes"))).rejects.toThrow(
      "file helper does not match its pinned hash"
    )
    await expect(install(f, "not-a-hash")).rejects.toThrow(
      "file helper does not match its pinned hash"
    )
    rmSync(f.source)
    await expect(install(f)).rejects.toThrow(
      "file helper does not match its pinned hash"
    )
    mkdirSync(f.source)
    await expect(install(f)).rejects.toThrow(
      "file helper does not match its pinned hash"
    )
    expect(privateDirs(f.parent)).toEqual([])
  })

  it("refuses a source over the size limit even when its pin is right", async () => {
    const f = fixture()
    // Sparse, so it takes no space; the pin is the hash of exactly those zero bytes.
    truncateSync(f.source, FILE_HELPER_SIZE_LIMIT + 1)
    const pin = createHash("sha256")
      .update(Buffer.alloc(FILE_HELPER_SIZE_LIMIT + 1))
      .digest("hex")
    await expect(install(f, pin)).rejects.toThrow(
      "file helper does not match its pinned hash"
    )
  })

  it.skipIf(!posix)(
    "refuses a source that is a symbolic link to the pinned bytes",
    async () => {
      const f = fixture()
      const real = join(f.base, "real-helper")
      writeFileSync(real, BYTES, { mode: 0o700 })
      rmSync(f.source)
      symlinkSync(real, f.source)
      await expect(install(f)).rejects.toThrow(
        "file helper does not match its pinned hash"
      )
    }
  )

  it.skipIf(!posix)(
    "refuses a parent another user could write or swap",
    async () => {
      const f = fixture()
      chmodSync(f.parent, 0o770)
      await expect(install(f)).rejects.toThrow("copy directory is unsafe")
      chmodSync(f.parent, 0o702)
      await expect(install(f)).rejects.toThrow("copy directory is unsafe")
      chmodSync(f.parent, 0o700)

      const alias = join(f.base, "alias")
      symlinkSync(f.parent, alias)
      await expect(
        installFileHelperCopy({ path: f.source, sha256: sha(BYTES) }, alias)
      ).rejects.toThrow("copy directory is unsafe")

      await expect(
        installFileHelperCopy(
          { path: f.source, sha256: sha(BYTES) },
          f.parent,
          statSync(f.parent).uid + 1
        )
      ).rejects.toThrow("copy directory is unsafe")
      const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid")
      Object.defineProperty(process, "geteuid", {
        value: undefined,
        configurable: true,
      })
      try {
        await expect(install(f)).rejects.toThrow("copy directory is unsafe")
      } finally {
        if (geteuid !== undefined)
          Object.defineProperty(process, "geteuid", geteuid)
      }

      chmodSync(f.base, 0o770)
      await expect(install(f)).rejects.toThrow("copy directory is unsafe")
      chmodSync(f.base, 0o700)

      await expect(
        installFileHelperCopy({ path: f.source, sha256: sha(BYTES) }, f.source)
      ).rejects.toThrow("copy directory is unsafe")
      expect(privateDirs(f.parent)).toEqual([])
    }
  )

  it.skipIf(!posix)("fails when the parent is missing", async () => {
    const f = fixture()
    rmSync(f.parent, { recursive: true })
    await expect(install(f)).rejects.toThrow("file helper copy failed")
  })

  it.skipIf(!posix || process.getuid?.() === 0)(
    "fails without leaving a directory when the parent cannot be written",
    async () => {
      const f = fixture()
      chmodSync(f.parent, 0o500)
      await expect(install(f)).rejects.toThrow("file helper copy failed")
      chmodSync(f.parent, 0o700)
      expect(privateDirs(f.parent)).toEqual([])
    }
  )

  it("removes copies an earlier gate left in the parent and nothing else", async () => {
    const f = fixture()
    const stale = join(f.parent, "eido-file-helper.0123456789abcdef")
    mkdirSync(stale, { mode: 0o700 })
    writeFileSync(join(stale, "file-helper"), BYTES)
    chmodSync(join(stale, "file-helper"), 0o500)
    writeFileSync(join(f.parent, "eido-file-helper.stray"), "x")
    writeFileSync(join(f.parent, "unrelated"), "kept")
    const copy = await install(f)
    expect(privateDirs(f.parent)).toEqual([basename(dirname(copy.path))])
    expect(readFileSync(join(f.parent, "unrelated"), "utf8")).toBe("kept")
  })

  it("remove deletes the copy and its directory, and the copy is refused after", async () => {
    const f = fixture()
    const copy = await install(f)
    await copy.remove()
    expect(existsSync(dirname(copy.path))).toBe(false)
    expect(await copy.verified()).toBeUndefined()
    await copy.remove()
    expect(privateDirs(f.parent)).toEqual([])
  })
})

describe("checking the copy before each run", () => {
  it("refuses a copy whose bytes changed in place", async () => {
    const copy = await install(fixture())
    chmodSync(copy.path, 0o700)
    writeFileSync(copy.path, "changed helper bytes")
    chmodSync(copy.path, 0o500)
    expect(await copy.verified()).toBeUndefined()
  })

  it("refuses a copy swapped for a new file with the same pinned bytes", async () => {
    const copy = await install(fixture())
    swap(copy.path, BYTES)
    expect(readFileSync(copy.path, "utf8")).toBe(BYTES)
    expect(await copy.verified()).toBeUndefined()
  })

  it("refuses a copy with a second hard link", async () => {
    const f = fixture()
    const copy = await install(f)
    linkSync(copy.path, join(f.base, "second-name"))
    expect(await copy.verified()).toBeUndefined()
  })

  it("refuses a copy that is gone", async () => {
    const copy = await install(fixture())
    chmodSync(copy.path, 0o700)
    rmSync(copy.path)
    expect(await copy.verified()).toBeUndefined()
  })

  it.skipIf(!posix)(
    "refuses a copy whose mode changed or that became a symbolic link",
    async () => {
      const f = fixture()
      const copy = await install(f)
      chmodSync(copy.path, 0o700)
      expect(await copy.verified()).toBeUndefined()
      chmodSync(copy.path, 0o500)
      expect(await copy.verified()).toBe(copy.path)
      const moved = join(f.base, "moved")
      chmodSync(dirname(copy.path), 0o700)
      linkSync(copy.path, moved)
      rmSync(copy.path)
      symlinkSync(moved, copy.path)
      expect(await copy.verified()).toBeUndefined()
    }
  )
})

/**
 * A synthetic helper: a shell script that drains the request on stdin, as the real helper does,
 * then prints one identify reply naming `marker`. `read` and `printf` are builtins, so the empty
 * environment the gate gives the helper is enough.
 */
const script = (marker: string) =>
  `#!/bin/sh\nwhile read -r _; do :; done\nprintf '%s' '{"ok":true,"op":"identify","canonicalPath":"/srv/example/${marker}","dev":"2a","ino":"1"}'\n`
const request = { op: "identify", path: "/srv/example/docs" } as const

describe.skipIf(!posix)("running the copy", () => {
  it("never runs a binary that replaced the configured path after start", async () => {
    const f = fixture(script("pinned"))
    const copy = await install(f, sha(script("pinned")))
    writeFileSync(f.source, script("replaced"), { mode: 0o700 })
    expect(await fileHelper(copy)(request)).toMatchObject({
      canonicalPath: "/srv/example/pinned",
    })
  })

  it("refuses a changed copy before it runs", async () => {
    const f = fixture(script("pinned"))
    const marker = join(f.base, "ran")
    const copy = await install(f, sha(script("pinned")))
    swap(copy.path, `#!/bin/sh\n: > '${marker}'\n`)
    await expect(fileHelper(copy)(request)).rejects.toThrow(
      /^file helper failed$/
    )
    expect(existsSync(marker)).toBe(false)
  })
})

describe("on Windows", () => {
  const real = process.platform
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: real })
  })

  it("checks the parent is a directory and the copy's identity and bytes, and leaves ownership to the ACL", async () => {
    const f = fixture()
    Object.defineProperty(process, "platform", { value: "win32" })
    const copy = await install(f)
    expect(await copy.verified()).toBe(copy.path)
    swap(copy.path, BYTES)
    expect(await copy.verified()).toBeUndefined()

    await expect(
      installFileHelperCopy({ path: f.source, sha256: sha(BYTES) }, f.source)
    ).rejects.toThrow("copy directory is unsafe")
    await expect(
      installFileHelperCopy(
        { path: f.source, sha256: sha(BYTES) },
        join(f.base, "missing")
      )
    ).rejects.toThrow("file helper copy failed")
  })
})
