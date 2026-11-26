import { renameSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  BRIDGE_MAX_REQUEST_BYTES,
  SessionBridgeError,
  SessionBridgeRefusal,
  SessionUnavailableError,
  bridgeStdout,
  createSessionBridge,
} from "./client"
import {
  answeringBridge,
  frame,
  socketDir,
  startFakeSessionBridge,
} from "./fake-session-bridge"
import type { SessionBridgeRequest } from "./client"
import type { FakeAnswer } from "./fake-session-bridge"

// Unix sockets and the plane split are macOS-only (#781); the gate on Windows never has a
// session bridge, so the socket tests do not run there. Answer handling runs everywhere.
const unix = process.platform === "win32" ? describe.skip : describe

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fake(answer: (request: unknown) => FakeAnswer) {
  const { dir, remove } = socketDir()
  cleanups.push(remove)
  const bridge = await startFakeSessionBridge(answer, join(dir, "bridge.sock"))
  cleanups.push(bridge.close)
  return bridge
}

/** A socket file nothing listens on, as a crashed bridge leaves behind. */
async function staleSocket(): Promise<string> {
  const { dir, remove } = socketDir()
  cleanups.push(remove)
  const live = join(dir, "live.sock")
  const stale = join(dir, "stale.sock")
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(live, resolve))
  // Closing unlinks the path it listened on; the renamed file stays, with no listener.
  renameSync(live, stale)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return stale
}

const call = { timeoutMs: 2000, maxResponseBytes: 1024 }
const things: Extract<SessionBridgeRequest, { op: "things" }> = {
  op: "things",
  script: "list-areas",
  sha256: "a".repeat(64),
  argv: [],
}

test("refuses a socket path that is not absolute", () => {
  expect(() => createSessionBridge("run/bridge.sock")).toThrow(
    "EIDO_SESSION_BRIDGE_SOCKET must be an absolute path"
  )
})

unix("session bridge client", () => {
  test("sends one framed request and returns the framed answer parsed", async () => {
    const bridge = await fake(() => ({ json: { ok: true, result: [1, "é"] } }))
    const answer = await createSessionBridge(bridge.socketPath).call(
      things,
      call
    )
    expect(answer).toEqual({ ok: true, result: [1, "é"] })
    expect(bridge.requests).toEqual([
      { op: "things", script: "list-areas", sha256: "a".repeat(64), argv: [] },
    ])
  })

  test("a missing socket is session_unavailable", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const error = await createSessionBridge(join(dir, "absent.sock"))
      .call(things, call)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionUnavailableError)
    expect(error).toMatchObject({ code: "session_unavailable" })
  })

  test("a socket that refuses the connection is session_unavailable", async () => {
    const error = await createSessionBridge(await staleSocket())
      .call(things, call)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionUnavailableError)
  })

  test("never connects to a path that is not a socket", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const file = join(dir, "bridge.sock")
    writeFileSync(file, "")
    await expect(createSessionBridge(file).call(things, call)).rejects.toThrow(
      "session bridge path is not a socket"
    )
  })

  test("an unreadable path is a bridge failure, not a missing session", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const file = join(dir, "file")
    writeFileSync(file, "")
    // lstat through a regular file as if it were a directory fails with ENOTDIR.
    const error = await createSessionBridge(join(file, "bridge.sock"))
      .call(things, call)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionBridgeError)
    expect(error).toMatchObject({
      message: "session bridge socket unreadable",
    })
  })

  test("refuses to send a request over the bridge's 8 MiB limit", async () => {
    const bridge = await fake(() => ({ json: { ok: true } }))
    const big = {
      op: "file",
      request: "x".repeat(BRIDGE_MAX_REQUEST_BYTES),
    } as const
    await expect(
      createSessionBridge(bridge.socketPath).call(big, call)
    ).rejects.toThrow("session bridge request too large")
    expect(bridge.connections()).toBe(0)
  })

  test.each([
    [
      "a zero length",
      Buffer.from([0, 0, 0, 0]),
      "session bridge frame refused",
    ],
    [
      "a length over the call's cap",
      Buffer.from([0, 0, 4, 1]),
      "session bridge frame refused",
    ],
    [
      "bytes after the frame",
      Buffer.concat([frame({ ok: true }), Buffer.from("x")]),
      "session bridge sent extra bytes",
    ],
    [
      "a close inside the body",
      frame({ ok: true }).subarray(0, 6),
      "session bridge closed early",
    ],
    [
      "a close inside the header",
      Buffer.from([0, 0]),
      "session bridge closed early",
    ],
    [
      "a body that is not JSON",
      Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{no")]),
      "session bridge answer is not JSON",
    ],
  ])("refuses %s", async (_name, raw, message) => {
    const bridge = await fake(() => ({ raw }))
    const error = await createSessionBridge(bridge.socketPath)
      .call(things, call)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionBridgeError)
    expect(error).toMatchObject({ message })
  })

  test("gives up at the deadline when the bridge never answers", async () => {
    const bridge = await fake(() => ({ hang: true }))
    await expect(
      createSessionBridge(bridge.socketPath).call(things, {
        timeoutMs: 100,
        maxResponseBytes: 1024,
      })
    ).rejects.toThrow("session bridge timed out")
  })

  test("a connection the bridge drops unread is a bridge failure", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const path = join(dir, "bridge.sock")
    // Like the bridge's ninth concurrent connection: closed with no response.
    const server = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(path, resolve))
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve()))
    )
    const error = await createSessionBridge(path)
      .call(things, call)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionBridgeError)
  })
})

describe("bridge stdout", () => {
  const run = (answer: unknown) =>
    bridgeStdout(answeringBridge(answer), things, call)

  test("decodes the child's stdout", async () => {
    expect(
      (await run({ ok: true, result: { stdoutBase64: "aGnDqQo=" } })).toString(
        "utf8"
      )
    ).toBe("hié\n")
  })

  test("a bridge code is a refusal carrying that code", async () => {
    const error = await run({ ok: false, code: "unknown_script" }).catch(
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(SessionBridgeRefusal)
    expect(error).toMatchObject({ code: "unknown_script" })
  })

  test.each([
    ["an answer outside the schema", { ok: true, result: { stdout: "aGk=" } }],
    ["a code the bridge does not send", { ok: false, code: "teapot" }],
    [
      "stdout that is not canonical base64",
      { ok: true, result: { stdoutBase64: "aG k=" } },
    ],
  ])("refuses %s", async (_name, answer) => {
    await expect(run(answer)).rejects.toBeInstanceOf(SessionBridgeError)
  })
})
