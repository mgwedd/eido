import { lstatSync } from "node:fs"
import { createConnection } from "node:net"
import { isAbsolute } from "node:path"
import { validateGateSessionBridgeResponse } from "@eido/schemas"
import type { GateSessionBridgeResponse } from "@eido/schemas"
import { trustedAncestors } from "../trusted-ancestors"
import type { Lstat } from "../trusted-ancestors"

// The gate's client for the session bridge (#826, decision in #781; protocol in
// apps/helper/README.md). Under the plane split the gate runs as `_eidogate`, outside the
// owner's login session, so Things, EventKit and the file helper run in the bridge, which
// listens on a Unix socket in that session. The bridge is a transport only: approval,
// policy, audit and the binary pins stay in the gate, and every answer is parsed again here.
// One request and one response per connection; a frame is a 4-byte big-endian length then
// UTF-8 JSON. Nothing here falls back to running a child process itself.
// Node cannot read a Unix socket's peer credentials, so the gate authenticates the bridge by
// the file system (#892): the socket must belong to the owner's uid and sit in directories
// only that uid or root can change. It is checked at start and again before every connect.

/** Names the bridge's socket. Unset, the gate spawns osascript and its helpers itself. */
export const SESSION_BRIDGE_SOCKET_ENV = "EIDO_SESSION_BRIDGE_SOCKET"
/**
 * The bridge's own time limits (apps/helper/README.md, "Session bridge"): the whole request must
 * arrive within 10 s of the peer check, and the response write has its own 10 s. A gate timeout
 * shorter than receive + operation + reply gives up while the bridge may still be writing (#893).
 */
export const BRIDGE_RECEIVE_MS = 10_000
export const BRIDGE_REPLY_MS = 10_000
/** Slack on top of the bridge's worst case, for connecting, scheduling and framing. */
export const BRIDGE_MARGIN_MS = 5_000

/** The gate timeout for a bridge op whose own limit is `operationMs`: above the bridge's worst case. */
export function bridgeTimeout(operationMs: number): number {
  return BRIDGE_RECEIVE_MS + operationMs + BRIDGE_REPLY_MS + BRIDGE_MARGIN_MS
}

/** The bridge refuses a longer request with `frame_too_large`; the client never sends one. */
export const BRIDGE_MAX_REQUEST_BYTES = 8 * 1024 * 1024
/** The bridge never sends a longer response; a header naming one is refused unread. */
export const BRIDGE_MAX_RESPONSE_BYTES = 24 * 1024 * 1024

/**
 * The bridge was not reached and no byte of the request was written: the socket is absent,
 * untrusted, refuses the connection, or the connection did not open before the deadline. The
 * executor relies on this: a write that fails with it was certainly not sent, so its approval
 * is not consumed (#893). Never raise it once the request frame has been written.
 */
export class SessionUnavailableError extends Error {
  readonly code = "session_unavailable"
  constructor(message = "session bridge unavailable") {
    super(message)
    this.name = "SessionUnavailableError"
  }
}

/**
 * The bridge call failed before the request was sent, for a reason other than an absent
 * bridge: a path that is not a socket, an unreadable path, or a request over the limit. Its
 * subclass `SessionBridgeOutcomeUnknownError` covers every failure after the request was sent.
 */
export class SessionBridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionBridgeError"
  }
}

/**
 * The request frame was written and no answer proves what happened (#912): the deadline
 * passed, the connection failed or closed early, or the answer was a bad frame, not JSON or
 * outside the schema. The bridge may have run the request. The executor records the outcome
 * as unknown, never as a clean failure. Only a schema-valid answer (a result or one of the
 * bridge's own codes) proves either outcome.
 */
export class SessionBridgeOutcomeUnknownError extends SessionBridgeError {
  constructor(message = "session bridge timed out after the request was sent") {
    super(message)
    this.name = "SessionBridgeOutcomeUnknownError"
  }
}

/** Whether `error`, or an error it wraps (`cause`), is an instance of `type`. */
function wraps(error: unknown, type: new (...args: never[]) => Error): boolean {
  for (let current = error, depth = 0; depth < 8; depth++) {
    if (current instanceof type) return true
    if (!(current instanceof Error)) return false
    current = current.cause
  }
  return false
}

/** Whether `error` says the bridge call sent nothing (`SessionUnavailableError`, wrapped or not). */
export function sentNothing(error: unknown): boolean {
  return wraps(error, SessionUnavailableError)
}

/** Whether `error` says a sent bridge call has an unknown outcome. */
export function outcomeUnknown(error: unknown): boolean {
  return wraps(error, SessionBridgeOutcomeUnknownError)
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

export type FrameReader = {
  /** Takes the next chunk; returns why the frame is refused, or nothing to keep reading. */
  push: (chunk: Buffer) => string | undefined
  /** At the close: the frame body, or why the frame is refused. */
  end: () => { body: Buffer } | { refused: string }
}

/** Collects one response frame of at most `limit` body bytes, as the socket delivers it. */
export function frameReader(limit: number): FrameReader {
  const chunks: Buffer[] = []
  let received = 0
  let expected: number | undefined
  return {
    push(chunk) {
      received += chunk.length
      chunks.push(chunk)
      if (expected === undefined && received >= 4) {
        expected = Buffer.concat(chunks).readUInt32BE(0)
        if (expected === 0 || expected > limit)
          return "session bridge frame refused"
      }
      if (expected !== undefined && received > 4 + expected)
        return "session bridge sent extra bytes"
      return undefined
    },
    // The bridge closes after its one response, so the frame is complete only at the close.
    end() {
      if (expected === undefined || received !== 4 + expected)
        return { refused: "session bridge closed early" }
      return { body: Buffer.concat(chunks).subarray(4) }
    },
  }
}

/** Parses a frame body; the caller checks the result against a schema. */
export function parseFrameBody(body: Buffer): unknown {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"))
    return parsed
  } catch {
    throw new SessionBridgeOutcomeUnknownError(
      "session bridge answer is not JSON"
    )
  }
}

/**
 * Why the connection failed (#912): before it opened nothing was written, so an absent or
 * refusing bridge is unavailable and anything else a plain failure. Once it opened the request
 * may have been written and run, so any failure, a reset included, is an unknown outcome.
 */
export function connectionError(
  sent: boolean,
  error: unknown
): SessionUnavailableError | SessionBridgeError {
  if (sent)
    return new SessionBridgeOutcomeUnknownError(
      "session bridge connection failed after the request was sent"
    )
  return absent(error)
    ? new SessionUnavailableError()
    : new SessionBridgeError("session bridge connection failed")
}

/**
 * Why an exchange stopped at its deadline: before the connection opened nothing was written, so
 * the bridge is unavailable; after it, the bridge may have run the request.
 */
export function deadlineError(
  sent: boolean
): SessionUnavailableError | SessionBridgeOutcomeUnknownError {
  return sent
    ? new SessionBridgeOutcomeUnknownError()
    : new SessionUnavailableError("session bridge did not accept")
}

function exchange(
  socketPath: string,
  frame: Buffer,
  { timeoutMs, maxResponseBytes }: SessionBridgeCall
): Promise<Buffer> {
  const reader = frameReader(
    Math.min(maxResponseBytes, BRIDGE_MAX_RESPONSE_BYTES)
  )
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    // The frame is written only once the connection is open, so before then nothing was sent.
    let sent = false
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
    const timer = setTimeout(() => finish(deadlineError(sent)), timeoutMs)
    socket.on("connect", () => {
      sent = true
      socket.write(frame)
    })
    socket.on("error", (error) => finish(connectionError(sent, error)))
    // Data and a close without an error come only after the connection opened, so after the
    // request may have been written: a bad or short frame proves neither outcome.
    socket.on("data", (chunk: Buffer) => {
      const refused = reader.push(chunk)
      if (refused !== undefined)
        finish(new SessionBridgeOutcomeUnknownError(refused))
    })
    socket.on("close", () => {
      const frame = reader.end()
      if ("refused" in frame)
        finish(new SessionBridgeOutcomeUnknownError(frame.refused))
      else if (settle()) resolve(frame.body)
    })
  })
}

/**
 * Whether the entry at `path` may be the owner's bridge: `not_socket` for a file, directory
 * or alias; `untrusted` for a socket another uid owns, one with a group or world write bit,
 * or one under a directory another principal can change. Errors from `lstat` propagate.
 */
export function socketRefusal(
  path: string,
  ownerUid: number,
  lstat: Lstat
): "not_socket" | "untrusted" | undefined {
  const entry = lstat(path)
  if (!entry.isSocket()) return "not_socket"
  if (
    entry.uid !== ownerUid ||
    (entry.mode & 0o022) !== 0 ||
    !trustedAncestors(path, ownerUid, lstat)
  )
    return "untrusted"
  return undefined
}

/**
 * The client for the bridge at `socketPath`, run by `ownerUid`. Before each connect the
 * socket and its directories are checked again (`socketRefusal`); a socket that is not the
 * owner's is `session_unavailable`, and no byte is sent to it.
 */
export function createSessionBridge(
  socketPath: string,
  ownerUid: number,
  lstat: Lstat = lstatSync
): SessionBridge {
  if (!isAbsolute(socketPath))
    throw new Error(`${SESSION_BRIDGE_SOCKET_ENV} must be an absolute path`)
  return {
    async call(request, options) {
      const body = Buffer.from(JSON.stringify(request), "utf8")
      if (body.length > BRIDGE_MAX_REQUEST_BYTES)
        throw new SessionBridgeError("session bridge request too large")
      let refusal
      try {
        refusal = socketRefusal(socketPath, ownerUid, lstat)
      } catch (error) {
        if (absent(error)) throw new SessionUnavailableError()
        throw new SessionBridgeError("session bridge socket unreadable")
      }
      // A file, directory or alias at the path is never connected to.
      if (refusal === "not_socket")
        throw new SessionBridgeError("session bridge path is not a socket")
      if (refusal === "untrusted")
        throw new SessionUnavailableError(
          "session bridge socket is not the owner's"
        )
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length, 0)
      return parseFrameBody(
        await exchange(socketPath, Buffer.concat([header, body]), options)
      )
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
  // An answer outside the schema proves neither outcome. One of the bridge's own codes is its
  // answer about the op, so it stays a refusal, as the direct runner's exit status would.
  if (!checked.ok)
    throw new SessionBridgeOutcomeUnknownError("session bridge answer refused")
  if (!checked.value.ok) throw new SessionBridgeRefusal(checked.value.code)
  const text = checked.value.result.stdoutBase64
  const bytes = Buffer.from(text, "base64")
  // Buffer.from skips characters outside the alphabet; a round trip proves there were none.
  if (bytes.toString("base64") !== text)
    throw new SessionBridgeOutcomeUnknownError(
      "session bridge stdout is not base64"
    )
  return bytes
}
