import { ChildProcess, spawn } from "node:child_process"
import { lstatSync, realpathSync, statSync } from "node:fs"
import type { Stats } from "node:fs"
import type * as FileSystem from "node:fs"
import type * as ChildProcesses from "node:child_process"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { APPLE_MAX_BYTES, APPLE_TIMEOUT_MS, createAppleRunner } from "./runner"

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystem>()),
  lstatSync: vi.fn(),
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
  return createAppleRunner(canonical, options)(request)
}

describe("portable EventKit process and filesystem boundary", () => {
  test("launches only the canonical executable with private pipes and a scrubbed environment", async () => {
    let sent = ""
    input.on("data", (data: Buffer) => {
      sent += data.toString("utf8")
    })
    const pending = createAppleRunner(
      "/gate/build/release/helper",
      options
    )(request)
    expect(spawn).toHaveBeenCalledWith(canonical, [], {
      cwd: "/",
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
      createAppleRunner(canonical, { platform: "win32" })(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      createAppleRunner("relative", options)(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      createAppleRunner(
        canonical,
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
        "/gate/build/release/helper",
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
