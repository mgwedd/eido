import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { basename, dirname, join, normalize } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFileHelperCopy } from "./file-helper-copy"

/**
 * The POSIX ownership, mode and identity checks, run against an in-memory file system so they
 * run on every platform (Windows CI included), as `file-install.platform.test.ts` does for the
 * install checks. The real file system cases are in `file-helper-copy.test.ts`.
 */

type Entry = {
  kind: "file" | "dir" | "link"
  uid: number
  mode: number
  ino: number
  nlink: number
  bytes: Buffer
  /** Reads never reach end of file: a file that keeps growing while it is read. */
  endless?: boolean
}
const ME = 501
const fs = vi.hoisted(() => ({
  entries: new Map<string, unknown>(),
  /** Error codes `open` throws for a path. */
  openFails: new Map<string, string>(),
  /** Paths whose `chmod` has no effect, as on a volume that ignores modes. */
  chmodIgnored: new Set<string>(),
  /** What `realpath` returns for a path, when it is not the path itself. */
  realpaths: new Map<string, string>(),
  trusted: { value: true },
  nextIno: { value: 1 },
}))
vi.mock("../trusted-ancestors", () => ({
  trustedAncestors: () => fs.trusted.value,
}))

const key = (path: string) => normalize(path)
const get = (path: string): Entry | undefined => {
  const found = fs.entries.get(key(path))
  return found === undefined ? undefined : (found as Entry)
}
const fail = (code: string) => Object.assign(new Error(code), { code })
const statOf = (entry: Entry) => ({
  dev: 1n,
  ino: BigInt(entry.ino),
  nlink: BigInt(entry.nlink),
  uid: BigInt(entry.uid),
  mode: BigInt(entry.mode),
  size: BigInt(entry.bytes.length),
  isFile: () => entry.kind === "file",
  isDirectory: () => entry.kind === "dir",
})
function put(path: string, entry: Omit<Entry, "ino" | "nlink">): Entry {
  const full = { ...entry, ino: fs.nextIno.value++, nlink: 1 }
  fs.entries.set(key(path), full)
  return full
}

vi.mock("node:fs/promises", () => ({
  open: (path: string, flags: number, mode?: number) => {
    const code = fs.openFails.get(key(path))
    if (code !== undefined) return Promise.reject(fail(code))
    let entry = get(path)
    if ((flags & constants.O_CREAT) !== 0) {
      if (entry !== undefined) return Promise.reject(fail("EEXIST"))
      entry = put(path, {
        kind: "file",
        uid: ME,
        mode: mode ?? 0o600,
        bytes: Buffer.alloc(0),
      })
    }
    if (entry === undefined) return Promise.reject(fail("ENOENT"))
    if (entry.kind === "link") return Promise.reject(fail("ELOOP"))
    const opened = entry
    let position = 0
    return Promise.resolve({
      stat: () => Promise.resolve(statOf(opened)),
      read: (buffer: Buffer) => {
        if (opened.endless === true)
          return Promise.resolve({ bytesRead: buffer.length })
        const bytesRead = opened.bytes.copy(buffer, 0, position)
        position += bytesRead
        return Promise.resolve({ bytesRead })
      },
      writeFile: (bytes: Buffer) => {
        opened.bytes = Buffer.from(bytes)
        return Promise.resolve()
      },
      chmod: (next: number) => {
        if (!fs.chmodIgnored.has(key(path))) opened.mode = next
        return Promise.resolve()
      },
      close: () => Promise.resolve(),
    })
  },
  lstat: (path: string) => {
    const entry = get(path)
    return entry === undefined
      ? Promise.reject(fail("ENOENT"))
      : Promise.resolve(statOf(entry))
  },
  realpath: (path: string) =>
    Promise.resolve(fs.realpaths.get(key(path)) ?? key(path)),
  mkdir: (path: string, options: { mode: number }) => {
    if (get(path) !== undefined) return Promise.reject(fail("EEXIST"))
    if (get(dirname(path))?.kind !== "dir")
      return Promise.reject(fail("ENOENT"))
    put(path, {
      kind: "dir",
      uid: ME,
      mode: options.mode & ~0o022,
      bytes: Buffer.alloc(0),
    })
    return Promise.resolve()
  },
  chmod: (path: string, mode: number) => {
    const entry = get(path)
    if (entry === undefined) return Promise.reject(fail("ENOENT"))
    if (!fs.chmodIgnored.has(key(path))) entry.mode = mode
    return Promise.resolve()
  },
  readdir: (path: string) =>
    Promise.resolve(
      [...fs.entries.keys()]
        .filter((p) => dirname(p) === key(path))
        .map((p) => basename(p))
    ),
  rm: (path: string) => {
    for (const p of [...fs.entries.keys()])
      if (p === key(path) || p.startsWith(key(path) + normalize("/")))
        fs.entries.delete(p)
    return Promise.resolve()
  },
}))

const BYTES = Buffer.from("synthetic helper bytes")
const PIN = createHash("sha256").update(BYTES).digest("hex")
const PARENT = join("/", "srv", "eido", "data")
const SOURCE = join("/", "srv", "eido", "bin", "eido-file-helper")
const helper = { path: SOURCE, sha256: PIN }
const install = (owner: number | undefined = ME) =>
  installFileHelperCopy(helper, PARENT, owner)
/** The private directory the install made under the parent. */
const madeDirectory = () => {
  const made = [...fs.entries.keys()].filter(
    (p) => dirname(p) === key(PARENT) && get(p)?.kind === "dir"
  )
  return made.length === 1 ? made[0] : undefined
}

const realPlatform = process.platform
beforeEach(() => {
  fs.entries.clear()
  fs.openFails.clear()
  fs.chmodIgnored.clear()
  fs.realpaths.clear()
  fs.trusted.value = true
  Object.defineProperty(process, "platform", { value: "linux" })
  put(PARENT, { kind: "dir", uid: ME, mode: 0o700, bytes: Buffer.alloc(0) })
  put(SOURCE, { kind: "file", uid: ME, mode: 0o700, bytes: BYTES })
})
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform })
})

describe("the private copy with synthetic ownership and modes", () => {
  it("installs an owner-only 0500 copy in an owner-only 0700 directory and verifies it", async () => {
    const copy = await install()
    expect(get(copy.path)).toMatchObject({ uid: ME, mode: 0o500 })
    expect(get(dirname(copy.path))).toMatchObject({ uid: ME, mode: 0o700 })
    expect(get(copy.path)?.bytes.equals(BYTES)).toBe(true)
    expect(await copy.verified()).toBe(copy.path)
  })

  it("refuses a source that is a directory, or that keeps growing past the size limit", async () => {
    put(SOURCE, { kind: "dir", uid: ME, mode: 0o700, bytes: Buffer.alloc(0) })
    await expect(install()).rejects.toThrow(
      "file helper does not match its pinned hash"
    )
    put(SOURCE, {
      kind: "file",
      uid: ME,
      mode: 0o700,
      bytes: BYTES,
      endless: true,
    })
    await expect(install()).rejects.toThrow(
      "file helper does not match its pinned hash"
    )
    expect(madeDirectory()).toBeUndefined()
  })

  it.each([
    ["owned by another user", { uid: 7 }],
    ["group writable", { mode: 0o720 }],
    ["world writable", { mode: 0o702 }],
  ])("refuses a parent %s", async (_name, over) => {
    Object.assign(get(PARENT) ?? {}, over)
    await expect(install()).rejects.toThrow("copy directory is unsafe")
  })

  it("refuses a parent with an untrusted ancestor, or whose canonical path names another directory", async () => {
    fs.trusted.value = false
    await expect(install()).rejects.toThrow("copy directory is unsafe")
    fs.trusted.value = true
    const other = join("/", "srv", "other")
    put(other, { kind: "dir", uid: ME, mode: 0o700, bytes: Buffer.alloc(0) })
    fs.realpaths.set(key(PARENT), key(other))
    await expect(install()).rejects.toThrow("copy directory is unsafe")
  })

  it.each([
    ["a symbolic link", "ELOOP", "copy directory is unsafe"],
    ["not a directory", "ENOTDIR", "copy directory is unsafe"],
    ["unreadable", "EACCES", "file helper copy failed"],
  ])("refuses a parent that is %s", async (_name, code, message) => {
    fs.openFails.set(key(PARENT), code)
    await expect(install()).rejects.toThrow(message)
  })

  it("refuses to install with no owner to check against", async () => {
    const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid")
    Object.defineProperty(process, "geteuid", {
      value: undefined,
      configurable: true,
    })
    try {
      await expect(installFileHelperCopy(helper, PARENT)).rejects.toThrow(
        "copy directory is unsafe"
      )
    } finally {
      if (geteuid !== undefined)
        Object.defineProperty(process, "geteuid", geteuid)
    }
  })

  it("fails and leaves nothing when the private directory or the copy does not get its mode", async () => {
    // Every chmod under the parent is ignored: the directory keeps the mode mkdir gave it.
    const ignoreUnder = (made: string) => {
      fs.chmodIgnored.add(key(made))
      fs.chmodIgnored.add(key(join(made, "file-helper")))
    }
    const mkdirMode = (path: string) => {
      const entry = get(path)
      if (entry !== undefined) entry.mode = 0o755
    }
    const realPut = fs.entries.set.bind(fs.entries)
    fs.entries.set = (path, value) => {
      const result = realPut(path, value)
      if (dirname(path) === key(PARENT)) {
        ignoreUnder(path)
        mkdirMode(path)
      }
      return result
    }
    try {
      await expect(install()).rejects.toThrow("file helper copy failed")
      expect(madeDirectory()).toBeUndefined()
      // Now the directory gets its mode but the copy does not.
      fs.entries.set = (path, value) => {
        const result = realPut(path, value)
        if (basename(path) === "file-helper") fs.chmodIgnored.add(path)
        return result
      }
      await expect(install()).rejects.toThrow("file helper copy failed")
      expect(madeDirectory()).toBeUndefined()
    } finally {
      fs.entries.set = realPut
    }
  })

  it.each([
    [
      "its mode changed",
      (entry: Entry) => {
        entry.mode = 0o700
      },
    ],
    [
      "another user owns it",
      (entry: Entry) => {
        entry.uid = 7
      },
    ],
    [
      "it has a second link",
      (entry: Entry) => {
        entry.nlink = 2
      },
    ],
    [
      "it is another file now",
      (entry: Entry) => {
        entry.ino += 1000
      },
    ],
    [
      "its bytes changed",
      (entry: Entry) => {
        entry.bytes = Buffer.from("changed helper bytes")
      },
    ],
  ])("refuses the copy before a run once %s", async (_name, change) => {
    const copy = await install()
    const entry = get(copy.path)
    if (entry === undefined) throw new Error("the copy was not made")
    change(entry)
    expect(await copy.verified()).toBeUndefined()
  })

  it("no longer verifies a removed copy", async () => {
    const copy = await install()
    await copy.remove()
    expect(get(copy.path)).toBeUndefined()
    expect(await copy.verified()).toBeUndefined()
  })
})
