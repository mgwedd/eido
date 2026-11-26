import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { fileHelper } from "./file-helper"
import { installFileHelperCopy } from "./file-helper-copy"
import type { FileHelperCopy } from "./file-helper-copy"

const mocked = vi.hoisted(() => ({
  spawn: vi.fn<(path: string, args: string[], options: object) => unknown>(),
}))
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }))
class Pipe extends EventEmitter {
  end = vi.fn<(value: string) => void>()
  resume = vi.fn()
}
class Child extends EventEmitter {
  stdin = new Pipe()
  stdout = new Pipe()
  stderr = new Pipe()
  kill = vi.fn()
}

const dir = realpathSync.native(
  mkdtempSync(join(tmpdir(), "eido-file-helper-"))
)
const binary = join(dir, "eido-file-helper")
writeFileSync(binary, "synthetic helper bytes")
const sha256 = createHash("sha256")
  .update("synthetic helper bytes")
  .digest("hex")
let copy: FileHelperCopy
beforeAll(async () => {
  copy = await installFileHelperCopy({ path: binary, sha256 }, dir)
})
afterAll(async () => {
  await copy.remove()
  rmSync(dir, { recursive: true, force: true })
})

/** A copy in a parent of its own: installing removes every earlier copy in its parent. */
const ownCopy = () =>
  installFileHelperCopy(
    { path: binary, sha256 },
    realpathSync.native(mkdtempSync(join(dir, "parent-")))
  )

let child: Child
beforeEach(() => {
  child = new Child()
  mocked.spawn.mockReset().mockReturnValue(child)
})
const request = { op: "identify", path: "/srv/example/docs" } as const
/** Lets the pin check's file read finish so the helper has been spawned. */
const spawned = () => vi.waitFor(() => expect(mocked.spawn).toHaveBeenCalled())

test("spawns the private copy with no arguments or environment and parses its reply", async () => {
  const reply = fileHelper(copy)(request)
  await spawned()
  const [path, args, options] = mocked.spawn.mock.calls[0] ?? []
  expect(path).toBe(copy.path)
  expect(args).toEqual([])
  expect(options).toMatchObject({ env: {}, shell: false, stdio: "pipe" })
  expect(child.stdin.end.mock.calls[0]?.[0]).toBe(JSON.stringify(request))
  expect(child.stderr.resume).toHaveBeenCalledOnce()
  child.stdout.emit(
    "data",
    Buffer.from(
      '{"ok":true,"op":"identify","canonicalPath":"/srv/example/docs","dev":"2a","ino":"1001"}\n'
    )
  )
  child.emit("close", 0)
  expect(await reply).toEqual({
    ok: true,
    op: "identify",
    canonicalPath: "/srv/example/docs",
    dev: "2a",
    ino: "1001",
  })
})

test("runs the copy, not a binary that replaced the configured path after start", async () => {
  const own = await ownCopy()
  try {
    writeFileSync(binary, "replacement helper bytes")
    const reply = fileHelper(own)(request)
    await spawned()
    expect(mocked.spawn.mock.calls[0]?.[0]).toBe(own.path)
    expect(readFileSync(own.path, "utf8")).toBe("synthetic helper bytes")
    child.emit("close", 2)
    await expect(reply).rejects.toThrow(/^file helper failed$/)
  } finally {
    writeFileSync(binary, "synthetic helper bytes")
    await own.remove()
  }
})

test("refuses a changed copy without running it", async () => {
  const own = await ownCopy()
  try {
    chmodSync(own.path, 0o700)
    writeFileSync(own.path, "changed helper bytes")
    chmodSync(own.path, 0o500)
    await expect(fileHelper(own)(request)).rejects.toThrow(
      /^file helper failed$/
    )
    await own.remove()
    await expect(fileHelper(own)(request)).rejects.toThrow(
      /^file helper failed$/
    )
    expect(mocked.spawn).not.toHaveBeenCalled()
  } finally {
    await own.remove()
  }
})

test("refuses a request outside the protocol without running the helper", async () => {
  const helper = fileHelper(copy)
  const unlink = JSON.parse('{"op":"unlink","path":"a"}') as Parameters<
    typeof helper
  >[0]
  await expect(helper(unlink)).rejects.toThrow("file helper failed")
  expect(mocked.spawn).not.toHaveBeenCalled()
})

test.each([
  "not-json",
  '{"ok":false,"code":"private-marker","message":"x"}',
  '{"ok":true,"op":"identify","canonicalPath":"/x","dev":"2a","ino":"1","extra":"private-marker"}',
])("rejects a malformed reply without reflecting it: %s", async (text) => {
  const reply = fileHelper(copy)(request)
  await spawned()
  child.stdout.emit("data", Buffer.from(text))
  child.emit("close", 0)
  await expect(reply).rejects.toThrow(/^file helper failed$/)
})

test.each(["spawn", "stdin", "exit", "overflow", "invalid-stream"])(
  "sanitizes %s failures",
  async (kind) => {
    const reply = fileHelper(copy)(request)
    await spawned()
    if (kind === "spawn") child.emit("error", new Error("private-marker"))
    else if (kind === "stdin")
      child.stdin.emit("error", new Error("private-marker"))
    else if (kind === "exit") child.emit("close", 2)
    else {
      child.stdout.emit(
        "data",
        kind === "overflow" ? Buffer.alloc(64 * 1024 + 1) : "private-marker"
      )
      expect(child.kill).toHaveBeenCalledOnce()
      child.emit("close", 0)
    }
    await expect(reply).rejects.toThrow(/^file helper failed$/)
  }
)

const root = { path: "/srv/example/docs", dev: "2a", ino: "1", trashDir: ".t" }
const listRequest = { op: "list", root, path: "" } as const
const readRequest = {
  op: "read",
  root,
  path: "a.txt",
  maxBytes: 1024,
} as const

test("a list reply over 512 KiB is cut off, while an identify-sized limit is not applied to it", async () => {
  const reply = fileHelper(copy)(listRequest)
  await spawned()
  child.stdout.emit("data", Buffer.alloc(512 * 1024 + 1))
  expect(child.kill).toHaveBeenCalledOnce()
  child.emit("close", 0)
  await expect(reply).rejects.toThrow(/^file helper failed$/)
})

test("a list reply between 64 KiB and 512 KiB is accepted and parsed", async () => {
  const reply = fileHelper(copy)(listRequest)
  await spawned()
  const name = "n".repeat(200)
  const entries = Array.from({ length: 400 }, () => ({ name, kind: "file" }))
  child.stdout.emit(
    "data",
    Buffer.from(
      JSON.stringify({ ok: true, op: "list", entries, truncated: false })
    )
  )
  child.emit("close", 0)
  expect(await reply).toMatchObject({ ok: true, op: "list" })
})

test("a read reply over 12 MiB is cut off but one just over the default limit is parsed", async () => {
  const over = fileHelper(copy)(readRequest)
  await spawned()
  child.stdout.emit("data", Buffer.alloc(12 * 1024 * 1024 + 1))
  expect(child.kill).toHaveBeenCalledOnce()
  child.emit("close", 0)
  await expect(over).rejects.toThrow(/^file helper failed$/)

  child = new Child()
  mocked.spawn.mockReset().mockReturnValue(child)
  const ok = fileHelper(copy)(readRequest)
  await spawned()
  child.stdout.emit(
    "data",
    Buffer.from(
      JSON.stringify({
        ok: true,
        op: "read",
        contentBase64: "A".repeat(100 * 1024),
      })
    )
  )
  child.emit("close", 0)
  expect(await ok).toMatchObject({ ok: true, op: "read" })
})
