import { ChildProcess, spawn } from "node:child_process"
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import type { Stats } from "node:fs"
import type * as FileSystem from "node:fs"
import type * as ChildProcesses from "node:child_process"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  APPLE_MAX_BYTES,
  APPLE_MAX_CONCURRENT,
  APPLE_TIMEOUT_MS,
  createAppleRunner,
} from "./runner"

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystem>()),
  lstatSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
  statSync: vi.fn(),
}))
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcesses>()),
  spawn: vi.fn(),
}))

const actualFs = await vi.importActual<typeof FileSystem>("node:fs")
const UID = 501
const canonical = "/gate/private/helper"
// SHA-256 of the bytes readFileSync returns below, computed with `shasum -a 256`.
const PIN = "3e285f58ed5340f25b63d1d2328d802c3e32fdd0ff0660a097eb3601ae83620e"
const pinned = (path: string) => ({ path, sha256: PIN })
const request = { operation: "list_calendars", args: {} } as const
const options = { platform: "darwin" } as const
const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid")
let child: ChildProcess
let input: PassThrough
let output: PassThrough
let kill = vi.fn(() => true)

function metadata(mode: number, uid = UID): Stats {
  const result = actualFs.lstatSync(import.meta.filename)
  result.mode = mode
  result.uid = uid
  return result
}
function safeEntry(path: Parameters<typeof lstatSync>[0]): Stats {
  return String(path).endsWith("/helper")
    ? metadata(0o100700)
    : metadata(0o040700)
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, "getuid", {
    configurable: true,
    writable: true,
    value: () => UID,
  })
  vi.mocked(lstatSync).mockImplementation(safeEntry)
  vi.mocked(statSync).mockImplementation(safeEntry)
  vi.mocked(realpathSync).mockReturnValue(canonical)
  vi.mocked(readFileSync).mockReturnValue(Buffer.from("synthetic helper bytes"))
  child = new ChildProcess()
  input = new PassThrough()
  output = new PassThrough()
  child.stdin = input
  child.stdout = output
  child.stderr = null
  kill = vi.fn(() => true)
  child.kill = kill
  vi.mocked(spawn).mockReturnValue(child)
})
afterEach(() => {
  vi.useRealTimers()
  // Undo the process.kill spies even when a test fails before its own restore.
  vi.restoreAllMocks()
  if (originalGetuid === undefined) Reflect.deleteProperty(process, "getuid")
  else Object.defineProperty(process, "getuid", originalGetuid)
  input.destroy()
  output.destroy()
})
function complete(value: unknown, code = 0): void {
  output.end(JSON.stringify(value))
  child.emit("close", code, null)
}
function run() {
  return createAppleRunner(pinned(canonical), options)(request)
}

describe("portable EventKit process and filesystem boundary", () => {
  test("launches only the canonical executable with private pipes and a scrubbed environment", async () => {
    let sent = ""
    input.on("data", (data: Buffer) => {
      sent += data.toString("utf8")
    })
    const pending = createAppleRunner(
      pinned("/gate/build/release/helper"),
      options
    )(request)
    expect(readFileSync).toHaveBeenCalledWith(canonical)
    expect(spawn).toHaveBeenCalledWith(canonical, [], {
      cwd: "/",
      detached: true,
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      stdio: ["pipe", "pipe", "ignore"],
    })
    expect(JSON.parse(sent)).toEqual({ operation: "list_calendars", args: {} })
    output.write('{"ok":true,"result":')
    output.write('{"calendars":[]}}')
    child.emit("close", 0, null)
    await expect(pending).resolves.toEqual({ calendars: [] })
  })
  test.each([
    ["non-file", 0o040700, UID],
    ["symlink", 0o120777, UID],
    ["not executable", 0o100600, UID],
    ["group writable", 0o100720, UID],
    ["world writable", 0o100702, UID],
    ["foreign owner", 0o100700, 502],
    ["root-owned executable", 0o100700, 0],
  ])(
    "refuses %s executable metadata before launching",
    async (_name, mode, uid) => {
      vi.mocked(lstatSync).mockReturnValue(metadata(Number(mode), Number(uid)))
      await expect(run()).rejects.toMatchObject({ code: "unavailable" })
      expect(spawn).not.toHaveBeenCalled()
    }
  )
  test("requires an OS identity and never leaks failed filesystem inspection details", async () => {
    Object.defineProperty(process, "getuid", {
      configurable: true,
      writable: true,
      value: undefined,
    })
    await expect(run()).rejects.toMatchObject({ code: "unavailable" })
    Object.defineProperty(process, "getuid", {
      configurable: true,
      writable: true,
      value: () => UID,
    })
    vi.mocked(realpathSync).mockImplementation(() => {
      throw new Error("private executable location")
    })
    await expect(run()).rejects.toMatchObject({
      message: "Apple Helper refused: unavailable",
    })
    expect(spawn).not.toHaveBeenCalled()
  })
  test.each([
    ["non-directory", 0o100700, UID],
    ["foreign owner", 0o040700, 502],
    ["group writable", 0o040770, UID],
    ["world writable", 0o040777, UID],
    ["foreign sticky owner", 0o041777, 502],
  ])(
    "refuses %s ancestors in both configured and canonical paths",
    async (_name, mode, uid) => {
      const unsafe = metadata(Number(mode), Number(uid))
      vi.mocked(statSync).mockImplementation((path) =>
        String(path) === "/gate/private" ? unsafe : safeEntry(path)
      )
      await expect(run()).rejects.toMatchObject({ code: "unavailable" })
      vi.mocked(statSync).mockImplementation(safeEntry)
      vi.mocked(lstatSync).mockImplementation((path) =>
        String(path) === "/gate/private" ? unsafe : safeEntry(path)
      )
      await expect(run()).rejects.toMatchObject({ code: "unavailable" })
      expect(spawn).not.toHaveBeenCalled()
    }
  )
  test.each([0, UID])(
    "permits protected children beneath a sticky ancestor owned by %s",
    async (uid) => {
      const entry = (path: Parameters<typeof lstatSync>[0]) =>
        String(path) === "/gate" ? metadata(0o041777, uid) : safeEntry(path)
      vi.mocked(statSync).mockImplementation(entry)
      vi.mocked(lstatSync).mockImplementation(entry)
      const pending = run()
      complete({ ok: true, result: { calendars: [] } })
      await expect(pending).resolves.toEqual({ calendars: [] })
    }
  )
  test("refuses unsupported configuration and malformed requests before file access", async () => {
    await expect(
      createAppleRunner(undefined, options)(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      createAppleRunner(pinned(canonical), { platform: "win32" })(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      createAppleRunner(pinned("relative"), options)(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      createAppleRunner(
        { path: canonical, sha256: PIN.toUpperCase() },
        options
      )(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      createAppleRunner(
        pinned(canonical),
        options
      )({
        operation: "list_events",
        args: { calendarId: "", start: "bad", end: "bad" },
      })
    ).rejects.toMatchObject({ code: "invalid_request" })
    expect(lstatSync).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
  test("rechecks the resolved executable rather than trusting an earlier file inspection", async () => {
    vi.mocked(lstatSync)
      .mockImplementationOnce(safeEntry)
      .mockReturnValueOnce(metadata(0o120777))
    await expect(run()).rejects.toMatchObject({ code: "unavailable" })
    expect(spawn).not.toHaveBeenCalled()
  })
  test("refuses an untrusted lexical alias even when its followed directory is trusted", async () => {
    vi.mocked(lstatSync).mockImplementation((path) =>
      String(path) === "/gate/private"
        ? metadata(0o120777, 502)
        : safeEntry(path)
    )
    vi.mocked(statSync).mockImplementation((path) =>
      String(path) === "/gate" ? metadata(0o041777, 0) : safeEntry(path)
    )
    await expect(run()).rejects.toMatchObject({ code: "unavailable" })
    expect(spawn).not.toHaveBeenCalled()
  })
  test.each([0, UID])(
    "permits a lexical alias owned by trusted principal %s",
    async (uid) => {
      vi.mocked(lstatSync).mockImplementation((path) =>
        String(path) === "/gate/build/release"
          ? metadata(0o120777, uid)
          : safeEntry(path)
      )
      const pending = createAppleRunner(
        pinned("/gate/build/release/helper"),
        options
      )(request)
      complete({ ok: true, result: { calendars: [] } })
      await expect(pending).resolves.toEqual({ calendars: [] })
      expect(spawn).toHaveBeenCalledWith(canonical, [], expect.anything())
    }
  )
  test("bounds a synchronous process startup failure", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error("private startup error")
    })
    await expect(run()).rejects.toMatchObject({
      code: "unavailable",
      message: "Apple Helper refused: unavailable",
    })
  })
  test.each(["child", "stdin", "stdout"])(
    "kills the child on a %s error without disclosing content",
    async (source) => {
      const pending = run()
      const stream =
        source === "stdin" ? input : source === "stdout" ? output : child
      stream.emit("error", new Error("private event content"))
      child.emit("close", 1, null)
      await expect(pending).rejects.toMatchObject({
        code: "unavailable",
        message: "Apple Helper refused: unavailable",
      })
      expect(kill).toHaveBeenCalledWith("SIGKILL")
    }
  )
  test.each([
    ["failed exit", "", 1],
    ["malformed JSON", "private text", 0],
    ["wrong result", '{"ok":true,"result":{"unexpected":true}}', 0],
  ])("rejects %s", async (_name, text, code) => {
    const pending = run()
    output.write(String(text))
    child.emit("close", Number(code), null)
    await expect(pending).rejects.toMatchObject({ code: "unavailable" })
  })
  test.each([
    "invalid_request",
    "permission_denied",
    "not_found",
    "read_only",
    "unsupported_event",
    "unavailable",
  ])("preserves only the validated Helper refusal code %s", async (code) => {
    const pending = run()
    complete({ ok: false, code })
    await expect(pending).rejects.toMatchObject({ code })
  })
  test("kills an oversized reply and ignores subsequent output or completion", async () => {
    const pending = run()
    output.write(Buffer.alloc(APPLE_MAX_BYTES + 1))
    complete({ ok: true, result: { calendars: [] } })
    await expect(pending).rejects.toMatchObject({ code: "unavailable" })
    expect(kill).toHaveBeenCalledTimes(1)
  })
  test("kills a child that exceeds its deadline", async () => {
    vi.useFakeTimers()
    const rejection = expect(run()).rejects.toMatchObject({
      code: "unavailable",
    })
    await vi.advanceTimersByTimeAsync(APPLE_TIMEOUT_MS)
    await rejection
    expect(kill).toHaveBeenCalledWith("SIGKILL")
  })
})

describe("EventKit Helper pin, concurrency cap and process group", () => {
  test("refuses a binary whose SHA-256 differs from the pin before launching", async () => {
    vi.mocked(readFileSync).mockReturnValue(Buffer.from("rebuilt helper bytes"))
    await expect(run()).rejects.toMatchObject({
      code: "unavailable",
      message: "Apple Helper refused: unavailable",
    })
    expect(spawn).not.toHaveBeenCalled()
  })
  test("refuses a binary it cannot read before launching", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("private read error")
    })
    await expect(run()).rejects.toMatchObject({ code: "unavailable" })
    expect(spawn).not.toHaveBeenCalled()
  })
  test("refuses a call beyond the cap until a running Helper exits", async () => {
    // Started children have a pid; never signal a real process group from a test.
    const groupKill = vi.spyOn(process, "kill").mockReturnValue(true)
    const children: ChildProcess[] = []
    const outputs: PassThrough[] = []
    vi.mocked(spawn).mockImplementation(() => {
      const next = new ChildProcess()
      Object.defineProperty(next, "pid", { value: 4300 + children.length })
      const stdout = new PassThrough()
      outputs.push(stdout)
      next.stdin = new PassThrough()
      next.stdout = stdout
      next.stderr = null
      next.kill = vi.fn(() => true)
      children.push(next)
      return next
    })
    const runner = createAppleRunner(pinned(canonical), options)
    const pending = Array.from({ length: APPLE_MAX_CONCURRENT }, () =>
      runner(request)
    )
    await expect(runner(request)).rejects.toMatchObject({
      code: "unavailable",
    })
    expect(spawn).toHaveBeenCalledTimes(APPLE_MAX_CONCURRENT)
    // A failed call still holds its slot while its process is alive.
    const [first] = children
    if (first === undefined) throw new Error("no Helper was launched")
    first.emit("error", new Error("private event content"))
    await expect(pending[0]).rejects.toMatchObject({ code: "unavailable" })
    await expect(runner(request)).rejects.toMatchObject({
      code: "unavailable",
    })
    expect(spawn).toHaveBeenCalledTimes(APPLE_MAX_CONCURRENT)
    first.emit("exit", null, "SIGKILL")
    const after = runner(request)
    expect(spawn).toHaveBeenCalledTimes(APPLE_MAX_CONCURRENT + 1)
    for (const [index, each] of children.entries()) {
      if (index === 0) continue
      outputs[index]?.end('{"ok":true,"result":{"calendars":[]}}')
      each.emit("exit", 0, null)
      each.emit("close", 0, null)
    }
    await expect(Promise.all([...pending.slice(1), after])).resolves.toEqual(
      Array.from({ length: APPLE_MAX_CONCURRENT }, () => ({ calendars: [] }))
    )
    expect(groupKill).toHaveBeenCalledWith(-4300, "SIGKILL")
  })
  test("a slot is released when the Helper cannot start", async () => {
    const runner = createAppleRunner(pinned(canonical), options)
    vi.mocked(spawn).mockImplementation(() => {
      const failed = new ChildProcess()
      failed.stdin = new PassThrough()
      failed.stdout = new PassThrough()
      failed.stderr = null
      failed.kill = vi.fn(() => true)
      queueMicrotask(() => failed.emit("error", new Error("ENOENT")))
      return failed
    })
    for (let i = 0; i <= APPLE_MAX_CONCURRENT; i += 1) {
      await expect(runner(request)).rejects.toMatchObject({
        code: "unavailable",
      })
    }
    expect(spawn).toHaveBeenCalledTimes(APPLE_MAX_CONCURRENT + 1)
  })
  test("kills the Helper's whole process group on timeout", async () => {
    vi.useFakeTimers()
    Object.defineProperty(child, "pid", { value: 4242 })
    const groupKill = vi.spyOn(process, "kill").mockReturnValue(true)
    const rejection = expect(run()).rejects.toMatchObject({
      code: "unavailable",
    })
    await vi.advanceTimersByTimeAsync(APPLE_TIMEOUT_MS)
    await rejection
    expect(groupKill).toHaveBeenCalledWith(-4242, "SIGKILL")
    expect(kill).toHaveBeenCalledWith("SIGKILL")
  })
})
