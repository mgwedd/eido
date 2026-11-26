import { chmodSync, lstatSync, renameSync, writeFileSync } from "node:fs"
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
  frameReader,
  parseFrameBody,
} from "./client"
import {
  TEST_OWNER_UID,
  answeringBridge,
  frame,
  socketDir,
  startFakeSessionBridge,
} from "./fake-session-bridge.test-support"
import type { SessionBridgeRequest } from "./client"
import type { Lstat } from "../trusted-ancestors"
import type { FakeAnswer } from "./fake-session-bridge.test-support"

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
  expect(() => createSessionBridge("run/bridge.sock", TEST_OWNER_UID)).toThrow(
    "EIDO_SESSION_BRIDGE_SOCKET must be an absolute path"
  )
})

// The path checks and the frame and body decoding need no listening socket, so these run on
// every platform.
describe("session bridge client checks", () => {
  test("a missing socket is session_unavailable", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const error = await createSessionBridge(
      join(dir, "absent.sock"),
      TEST_OWNER_UID
    )
      .call(things, call)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionUnavailableError)
    expect(error).toMatchObject({ code: "session_unavailable" })
  })

  test("never connects to a path that is not a socket", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const file = join(dir, "bridge.sock")
    writeFileSync(file, "")
    await expect(
      createSessionBridge(file, TEST_OWNER_UID).call(things, call)
    ).rejects.toThrow("session bridge path is not a socket")
  })

  test("a socket another uid owns is session_unavailable, not a missing session", async () => {
    // A double reports a socket owned by someone else; had the owner check been skipped, the
    // connect to this absent path would fail with the plain "unavailable" message instead.
    const lstat: Lstat = (path) => ({
      uid: path.endsWith(".sock") ? TEST_OWNER_UID + 1 : 0,
      mode: 0o755,
      isDirectory: () => !path.endsWith(".sock"),
      isSocket: () => path.endsWith(".sock"),
    })
    const error = await createSessionBridge(
      "/srv/run/bridge.sock",
      TEST_OWNER_UID,
      lstat
    )
      .call(things, call)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionUnavailableError)
    expect(error).toMatchObject({
      code: "session_unavailable",
      message: "session bridge socket is not the owner's",
    })
  })

  test("refuses a request over the bridge's 8 MiB limit before looking at the socket", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const big = {
      op: "file",
      request: "x".repeat(BRIDGE_MAX_REQUEST_BYTES),
    } as const
    // The path is absent: had the size check come later, this would be session_unavailable.
    await expect(
      createSessionBridge(join(dir, "absent.sock"), TEST_OWNER_UID).call(
        big,
        call
      )
    ).rejects.toThrow("session bridge request too large")
  })

  const read = (chunks: Buffer[], limit = 16) => {
    const reader = frameReader(limit)
    for (const chunk of chunks) {
      const refused = reader.push(chunk)
      if (refused !== undefined) return refused
    }
    const frame = reader.end()
    return "refused" in frame ? frame.refused : frame.body.toString("utf8")
  }

  test("reads a frame whose header and body arrive split across chunks", () => {
    const whole = frame({ a: 1 })
    expect(
      read([whole.subarray(0, 2), whole.subarray(2, 5), whole.subarray(5)])
    ).toBe('{"a":1}')
  })

  test("accepts a body exactly at the limit", () => {
    expect(read([frame("x".repeat(14))], 16)).toBe('"' + "x".repeat(14) + '"')
  })

  test.each([
    [
      "a zero length",
      [Buffer.from([0, 0, 0, 0])],
      "session bridge frame refused",
    ],
    [
      "a length over the limit",
      [Buffer.from([0, 0, 0, 17])],
      "session bridge frame refused",
    ],
    [
      "bytes after the frame",
      [frame({ ok: true }), Buffer.from("x")],
      "session bridge sent extra bytes",
    ],
    [
      "a close inside the body",
      [frame({ ok: true }).subarray(0, 6)],
      "session bridge closed early",
    ],
    [
      "a close inside the header",
      [Buffer.from([0, 0])],
      "session bridge closed early",
    ],
    ["a close before any byte", [], "session bridge closed early"],
  ])("refuses %s", (_name, chunks, message) => {
    expect(read(chunks)).toBe(message)
  })

  test("parses a body as JSON and refuses one that is not", () => {
    expect(parseFrameBody(Buffer.from('{"ok":true}'))).toEqual({ ok: true })
    expect(() => parseFrameBody(Buffer.from("{no"))).toThrow(
      "session bridge answer is not JSON"
    )
  })
})

unix("session bridge client", () => {
  test("sends one framed request and returns the framed answer parsed", async () => {
    const bridge = await fake(() => ({ json: { ok: true, result: [1, "é"] } }))
    const answer = await createSessionBridge(
      bridge.socketPath,
      TEST_OWNER_UID
    ).call(things, call)
    expect(answer).toEqual({ ok: true, result: [1, "é"] })
    expect(bridge.requests).toEqual([
      { op: "things", script: "list-areas", sha256: "a".repeat(64), argv: [] },
    ])
  })

  test("a socket replaced after start by another uid's is refused before any byte is sent", async () => {
    const bridge = await fake(() => ({ json: { ok: true } }))
    let replaced = false
    // Real ownership never changes in tests: after the swap, the double reports the socket
    // at the same path as another uid's, everything else as the real tree has it.
    const lstat: Lstat = (path) => {
      const stat = lstatSync(path)
      if (!replaced || path !== bridge.socketPath) return stat
      return {
        uid: TEST_OWNER_UID + 1,
        mode: stat.mode,
        isDirectory: () => stat.isDirectory(),
        isSocket: () => stat.isSocket(),
      }
    }
    const client = createSessionBridge(bridge.socketPath, TEST_OWNER_UID, lstat)
    expect(await client.call(things, call)).toEqual({ ok: true })
    replaced = true
    const error = await client.call(things, call).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionUnavailableError)
    expect(error).toMatchObject({ code: "session_unavailable" })
    expect(bridge.connections()).toBe(1)
    expect(bridge.requests).toHaveLength(1)
  })

  test("a socket or directory made group-writable after start is refused before connecting", async () => {
    const bridge = await fake(() => ({ json: { ok: true } }))
    const client = createSessionBridge(bridge.socketPath, TEST_OWNER_UID)
    expect(await client.call(things, call)).toEqual({ ok: true })
    chmodSync(bridge.socketPath, 0o660)
    await expect(client.call(things, call)).rejects.toMatchObject({
      code: "session_unavailable",
    })
    chmodSync(bridge.socketPath, 0o600)
    const dir = join(bridge.socketPath, "..")
    chmodSync(dir, 0o770)
    cleanups.push(() => chmodSync(dir, 0o700))
    await expect(client.call(things, call)).rejects.toMatchObject({
      code: "session_unavailable",
    })
    expect(bridge.connections()).toBe(1)
  })

  test("a socket that refuses the connection is session_unavailable", async () => {
    const error = await createSessionBridge(await staleSocket(), TEST_OWNER_UID)
      .call(things, call)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionUnavailableError)
  })

  test("an unreadable path is a bridge failure, not a missing session", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const file = join(dir, "file")
    writeFileSync(file, "")
    // lstat through a regular file as if it were a directory fails with ENOTDIR.
    const error = await createSessionBridge(
      join(file, "bridge.sock"),
      TEST_OWNER_UID
    )
      .call(things, call)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionBridgeError)
    expect(error).toMatchObject({
      message: "session bridge socket unreadable",
    })
  })

  test.each([
    [
      "a refused header",
      Buffer.from([0, 0, 0, 0]),
      "session bridge frame refused",
    ],
    [
      "a close inside the body",
      frame({ ok: true }).subarray(0, 6),
      "session bridge closed early",
    ],
    [
      "a body that is not JSON",
      Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{no")]),
      "session bridge answer is not JSON",
    ],
  ])("a frame with %s is a bridge failure", async (_name, raw, message) => {
    const bridge = await fake(() => ({ raw }))
    const error = await createSessionBridge(bridge.socketPath, TEST_OWNER_UID)
      .call(things, call)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionBridgeError)
    expect(error).toMatchObject({ message })
  })

  test("gives up at the deadline when the bridge never answers", async () => {
    const bridge = await fake(() => ({ hang: true }))
    await expect(
      createSessionBridge(bridge.socketPath, TEST_OWNER_UID).call(things, {
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
    chmodSync(path, 0o600)
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve()))
    )
    const error = await createSessionBridge(path, TEST_OWNER_UID)
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
