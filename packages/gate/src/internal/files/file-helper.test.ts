import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, expect, test, vi } from "vitest"
import { fileHelper } from "./file-helper"

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

const dir = mkdtempSync(join(tmpdir(), "eido-file-helper-"))
const binary = join(dir, "eido-file-helper")
writeFileSync(binary, "synthetic helper bytes")
const sha256 = createHash("sha256")
  .update("synthetic helper bytes")
  .digest("hex")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let child: Child
beforeEach(() => {
  child = new Child()
  mocked.spawn.mockReset().mockReturnValue(child)
})
const request = { op: "identify", path: "/srv/example/docs" } as const
/** Lets the pin check's file read finish so the helper has been spawned. */
const spawned = () => vi.waitFor(() => expect(mocked.spawn).toHaveBeenCalled())

test("spawns the pinned binary with no arguments or environment and parses its reply", async () => {
  const reply = fileHelper({ path: binary, sha256 })(request)
  await spawned()
  const [path, args, options] = mocked.spawn.mock.calls[0] ?? []
  expect(path).toBe(binary)
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

test("refuses a binary that does not match its pin without running it", async () => {
  await expect(
    fileHelper({ path: binary, sha256: "0".repeat(64) })(request)
  ).rejects.toThrow("file helper does not match its pinned hash")
  await expect(
    fileHelper({ path: join(dir, "missing"), sha256 })(request)
  ).rejects.toThrow("file helper failed")
  await expect(
    fileHelper({ path: binary, sha256: "not-a-hash" })(request)
  ).rejects.toThrow("file helper failed")
  expect(mocked.spawn).not.toHaveBeenCalled()
})

test("refuses a request outside the protocol without running the helper", async () => {
  const helper = fileHelper({ path: binary, sha256 })
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
  const reply = fileHelper({ path: binary, sha256 })(request)
  await spawned()
  child.stdout.emit("data", Buffer.from(text))
  child.emit("close", 0)
  await expect(reply).rejects.toThrow(/^file helper failed$/)
})

test.each(["spawn", "stdin", "exit", "overflow", "invalid-stream"])(
  "sanitizes %s failures",
  async (kind) => {
    const reply = fileHelper({ path: binary, sha256 })(request)
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
