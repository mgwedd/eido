import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { assertFileHelperInstall } from "./file-install"

type Stat = {
  isFile: () => boolean
  isDirectory: () => boolean
  uid: number
  mode: number
}
const mocked = vi.hoisted(() => ({
  lstat: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("node:fs/promises", () => ({ lstat: mocked.lstat }))

const ME = 501
const file = (over: Partial<Stat> = {}): Stat => ({
  isFile: () => true,
  isDirectory: () => false,
  uid: ME,
  mode: 0o700,
  ...over,
})
const dir = (over: Partial<Stat> = {}): Stat => ({
  isFile: () => false,
  isDirectory: () => true,
  uid: ME,
  mode: 0o700,
  ...over,
})
/** Serves synthetic stats by path so every ownership and mode case runs on every platform. */
function tree(entries: Record<string, Stat>): void {
  mocked.lstat.mockImplementation((path) => {
    const found = entries[path]
    return found === undefined
      ? Promise.reject(new Error("ENOENT"))
      : Promise.resolve(found)
  })
}
const HELPER = "/srv/eido/bin/helper"
const ANCESTORS = ["/srv/eido/bin", "/srv/eido", "/srv", "/"]
const privateTree = (over: Record<string, Stat> = {}) =>
  tree({
    [HELPER]: file(),
    ...Object.fromEntries(ANCESTORS.map((p) => [p, dir()])),
    ...over,
  })

const realPlatform = process.platform
const realGetuid = process.getuid
function setPlatform(value: string, uid: number | undefined): void {
  Object.defineProperty(process, "platform", { value })
  Object.defineProperty(process, "getuid", {
    value: uid === undefined ? undefined : () => uid,
    configurable: true,
  })
}
beforeEach(() => {
  mocked.lstat.mockReset()
  setPlatform("linux", ME)
})
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform })
  Object.defineProperty(process, "getuid", {
    value: realGetuid,
    configurable: true,
  })
})

describe("file helper install checks with synthetic ownership and modes", () => {
  it("accepts an owner-private tree", async () => {
    privateTree()
    await expect(assertFileHelperInstall(HELPER)).resolves.toBeUndefined()
  })

  it.each([
    ["owned by another user", { uid: 7 }],
    ["group writable", { mode: 0o720 }],
    ["world writable", { mode: 0o702 }],
    ["not executable", { mode: 0o600 }],
  ])("refuses a helper %s", async (_name, over) => {
    privateTree({ [HELPER]: file(over) })
    await expect(assertFileHelperInstall(HELPER)).rejects.toThrow(
      "owner-controlled"
    )
  })

  it("accepts a root-owned helper and refuses without a POSIX user id", async () => {
    privateTree({ [HELPER]: file({ uid: 0 }) })
    await expect(assertFileHelperInstall(HELPER)).resolves.toBeUndefined()
    setPlatform("linux", undefined)
    await expect(assertFileHelperInstall(HELPER)).rejects.toThrow(
      "owner-controlled"
    )
  })

  it.each([
    ["a group-writable ancestor", { "/srv/eido": dir({ mode: 0o770 }) }],
    ["an ancestor owned by another user", { "/srv": dir({ uid: 9 }) }],
    ["an ancestor that is not a directory", { "/srv": file() }],
    [
      "a user-owned sticky ancestor that others can write",
      { "/srv": dir({ mode: 0o1777 }) },
    ],
  ])("refuses %s", async (_name, over) => {
    privateTree(over)
    await expect(assertFileHelperInstall(HELPER)).rejects.toThrow(
      "owner-controlled"
    )
  })

  it("allows a root-owned sticky world-writable ancestor such as a temp directory", async () => {
    privateTree({ "/srv": dir({ uid: 0, mode: 0o1777 }) })
    await expect(assertFileHelperInstall(HELPER)).resolves.toBeUndefined()
  })

  it("on Windows requires a regular file in a directory and leaves the ACL to deployment", async () => {
    setPlatform("win32", undefined)
    privateTree({ [HELPER]: file({ uid: 7, mode: 0o666 }) })
    await expect(assertFileHelperInstall(HELPER)).resolves.toBeUndefined()
    privateTree({ "/srv/eido/bin": file() })
    await expect(assertFileHelperInstall(HELPER)).rejects.toThrow(
      "owner-controlled"
    )
  })
})
