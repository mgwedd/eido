import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionBridge, SessionBridgeRequest } from "./client"

// A stand-in for the session bridge in tests (#826), speaking the framing in
// apps/helper/README.md over a real Unix socket in a temp directory: a 4-byte big-endian
// length, then UTF-8 JSON, one request and one response per connection. Tests only.

/** What the fake sends back: a JSON value framed as the bridge would, raw bytes, or nothing. */
export type FakeAnswer = { json: unknown } | { raw: Buffer } | { hang: true }

export type FakeSessionBridge = {
  socketPath: string
  /** Every request body the fake received, parsed, in order. */
  requests: unknown[]
  /** Connections accepted, including ones that sent nothing. */
  connections: () => number
  close: () => Promise<void>
}

export function frame(json: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(json), "utf8")
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/**
 * An in-memory bridge that answers every call with `answer`, already parsed. It has no
 * socket, so tests of what the gate does with an answer run on every platform.
 */
export function answeringBridge(
  answer: unknown
): SessionBridge & { requests: SessionBridgeRequest[] } {
  const requests: SessionBridgeRequest[] = []
  return {
    requests,
    call: (request) => {
      requests.push(request)
      return Promise.resolve(answer)
    },
  }
}

/**
 * The uid the test runs as, which owns the sockets it creates. Windows has none; its tests
 * never reach a socket, so any number serves there.
 */
export const TEST_OWNER_UID = process.getuid?.() ?? 0

/**
 * A temp directory short enough for a Unix socket path, removed by the returned cleanup. It is
 * resolved, since the client refuses an alias above the socket (macOS's `/var` is one).
 */
export function socketDir(): { dir: string; remove: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eido-sb-")))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

export async function startFakeSessionBridge(
  answer: (request: unknown) => FakeAnswer,
  socketPath: string
): Promise<FakeSessionBridge> {
  const requests: unknown[] = []
  const open = new Set<Socket>()
  let connections = 0
  const server = createServer((socket) => {
    connections += 1
    open.add(socket)
    socket.on("close", () => open.delete(socket))
    socket.on("error", () => socket.destroy())
    let buffered = Buffer.alloc(0)
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length < 4) return
      const length = buffered.readUInt32BE(0)
      if (buffered.length < 4 + length) return
      const request: unknown = JSON.parse(
        buffered.subarray(4, 4 + length).toString("utf8")
      )
      requests.push(request)
      const reply = answer(request)
      if ("hang" in reply) return
      socket.end("json" in reply ? frame(reply.json) : reply.raw)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  // The bridge binds its socket 0600 (apps/helper/README.md); the client refuses a group or
  // world write bit, so the fake does not depend on the test's umask.
  chmodSync(socketPath, 0o600)
  return {
    socketPath,
    requests,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
