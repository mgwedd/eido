import { lstat } from "node:fs/promises"
import { createConnection } from "node:net"
import { isAbsolute } from "node:path"
import { validateGateSessionBridgeResponse } from "@eido/schemas"
import type { GateSessionBridgeResponse } from "@eido/schemas"

// The gate's client for the session bridge (#826, decision in #781; protocol in
// apps/helper/README.md). Under the plane split the gate runs as `_eidogate`, outside the
// owner's login session, so Things, EventKit and the file helper run in the bridge, which
// listens on a Unix socket in that session. The bridge is a transport only: approval,
// policy, audit and the binary pins stay in the gate, and every answer is parsed again here.
// One request and one response per connection; a frame is a 4-byte big-endian length then
// UTF-8 JSON. Nothing here falls back to running a child process itself.

/** Names the bridge's socket. Unset, the gate spawns osascript and its helpers itself. */
export const SESSION_BRIDGE_SOCKET_ENV = "EIDO_SESSION_BRIDGE_SOCKET"
/** The bridge refuses a longer request with `frame_too_large`; the client never sends one. */
export const BRIDGE_MAX_REQUEST_BYTES = 8 * 1024 * 1024
/** The bridge never sends a longer response; a header naming one is refused unread. */
export const BRIDGE_MAX_RESPONSE_BYTES = 24 * 1024 * 1024

/** The socket is not there or nothing listens on it: the owner's session is not running the bridge. */
export class SessionUnavailableError extends Error {
  readonly code = "session_unavailable"
  constructor() {
    super("session bridge unavailable")
    this.name = "SessionUnavailableError"
  }
}

/** The bridge was reached but the exchange failed: a timeout, a bad frame or a bad answer. */
export class SessionBridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionBridgeError"
  }
}

/** The bridge answered with one of its own codes (`unknown_script`, `automation_denied`, ...). */
export class SessionBridgeRefusal extends Error {
  readonly code: Extract<GateSessionBridgeResponse, { ok: false }>["code"]
  constructor(code: Extract<GateSessionBridgeResponse, { ok: false }>["code"]) {
    super(`session bridge refused: ${code}`)
    this.name = "SessionBridgeRefusal"
    this.code = code
  }
}

export type SessionBridgeRequest =
  | { op: "eventkit"; request: unknown }
  | { op: "things"; script: string; sha256: string; argv: string[] }
  | { op: "file"; request: unknown }

export type SessionBridgeCall = {
  /** The whole exchange, connect to close. */
  timeoutMs: number
  /** Frame bodies above this are refused before they are read. At most BRIDGE_MAX_RESPONSE_BYTES. */
  maxResponseBytes: number
}

export type SessionBridge = {
  /** Sends one request and returns the response body parsed as JSON, unchecked. */
  call: (
    request: SessionBridgeRequest,
    options: SessionBridgeCall
  ) => Promise<unknown>
}

const absent = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ECONNREFUSED")

function exchange(
  socketPath: string,
  frame: Buffer,
  { timeoutMs, maxResponseBytes }: SessionBridgeCall
): Promise<Buffer> {
  const limit = Math.min(maxResponseBytes, BRIDGE_MAX_RESPONSE_BYTES)
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    const chunks: Buffer[] = []
    let received = 0
    let expected: number | undefined
    let settled = false
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      socket.destroy()
      return true
    }
    const finish = (error: Error) => {
      if (settle()) reject(error)
    }
    const timer = setTimeout(
      () => finish(new SessionBridgeError("session bridge timed out")),
      timeoutMs
    )
    socket.on("error", (error) =>
      finish(
        absent(error)
          ? new SessionUnavailableError()
          : new SessionBridgeError("session bridge connection failed")
      )
    )
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length
      chunks.push(chunk)
      if (expected === undefined && received >= 4) {
        expected = Buffer.concat(chunks).readUInt32BE(0)
        if (expected === 0 || expected > limit)
          return finish(new SessionBridgeError("session bridge frame refused"))
      }
      if (expected !== undefined && received > 4 + expected)
        finish(new SessionBridgeError("session bridge sent extra bytes"))
    })
    // The bridge closes after its one response, so the frame is complete only at the close.
    socket.on("close", () => {
      if (expected === undefined || received !== 4 + expected)
        return finish(new SessionBridgeError("session bridge closed early"))
      if (settle()) resolve(Buffer.concat(chunks).subarray(4))
    })
    socket.write(frame)
  })
}

export function createSessionBridge(socketPath: string): SessionBridge {
  if (!isAbsolute(socketPath))
    throw new Error(`${SESSION_BRIDGE_SOCKET_ENV} must be an absolute path`)
  return {
    async call(request, options) {
      const body = Buffer.from(JSON.stringify(request), "utf8")
      if (body.length > BRIDGE_MAX_REQUEST_BYTES)
        throw new SessionBridgeError("session bridge request too large")
      let kind
      try {
        kind = await lstat(socketPath)
      } catch (error) {
        if (absent(error)) throw new SessionUnavailableError()
        throw new SessionBridgeError("session bridge socket unreadable")
      }
      // A file, directory or alias at the path is never connected to.
      if (!kind.isSocket())
        throw new SessionBridgeError("session bridge path is not a socket")
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length, 0)
      const answer = await exchange(
        socketPath,
        Buffer.concat([header, body]),
        options
      )
      try {
        const parsed: unknown = JSON.parse(answer.toString("utf8"))
        return parsed
      } catch {
        throw new SessionBridgeError("session bridge answer is not JSON")
      }
    },
  }
}

/**
 * Runs a `things` or `file` op and returns the child's stdout bytes. Anything but a
 * schema-valid `stdoutBase64` answer whose text is canonical base64 throws.
 */
export async function bridgeStdout(
  bridge: SessionBridge,
  request: Extract<SessionBridgeRequest, { op: "things" | "file" }>,
  options: SessionBridgeCall
): Promise<Buffer> {
  const checked = validateGateSessionBridgeResponse(
    await bridge.call(request, options)
  )
  if (!checked.ok) throw new SessionBridgeError("session bridge answer refused")
  if (!checked.value.ok) throw new SessionBridgeRefusal(checked.value.code)
  const text = checked.value.result.stdoutBase64
  const bytes = Buffer.from(text, "base64")
  // Buffer.from skips characters outside the alphabet; a round trip proves there were none.
  if (bytes.toString("base64") !== text)
    throw new SessionBridgeError("session bridge stdout is not base64")
  return bytes
}
