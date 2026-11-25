import { createHash } from "node:crypto"
import {
  chmodSync,
  lstatSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { connect, createServer } from "node:net"
import type { Server, Socket } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  MAX_HEADER_BYTES,
  frame,
  maxResponseBytes,
  readRequestHeader,
} from "./broker-wire"
import type { RequestHeader } from "./broker-wire"
import { createLimiter } from "./limiter"
import { readParseResult } from "./parse-document"
import {
  createPrivateWorkDirectory,
  preparePrivateScratchRoot,
} from "./private-scratch"
import { runInChild } from "./sandbox"
import type { FailureReason, ParseResult } from "./types"
import type { WorkerPayload } from "./worker"

// The parser broker (#817): a Unix-socket server that takes the bytes of one document per
// connection, runs one parse child for it with runInChild and answers with the ParseResult as
// JSON. It exists so the parse children inherit the broker's OS sandbox (ADR 0003, #778), not
// core's. It treats every document as hostile and never reads core's data dir, the gate's
// socket or any token: it is given a socket path and a scratch dir of its own, and nothing else.
// It logs nothing about documents.

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "worker.ts")

/** A hash for answers about a request whose header could not be read. */
const NO_SHA256 = "0".repeat(64)

/** How long a finished answer waits for the client to take it before the socket is destroyed. */
const RESPONSE_GRACE_MS = 2_000

export type BrokerConfig = {
  /** The Unix socket path to listen on. A stale socket file at the path is replaced. */
  socketPath: string
  /** The broker's own scratch dir (private, 0700): documents and child work dirs live here. */
  scratchDir: string
  /** The OCR engine by absolute path; without one, OCR is `ocr_unavailable`. */
  ocrBinary?: string
  /** Parses running at once; the rest queue. Default 2. */
  maxConcurrent?: number
  /** Time a client has to send its whole request before it is dropped. Default 30 s. */
  requestTimeoutMs?: number
  /**
   * The socket's file mode. Default 0o660: the owner and the group that core's user shares with
   * the broker. The directory the socket sits in is the other half of the access rule.
   */
  socketMode?: number
  /** The parse child's entry module. Tests substitute a fake child; production never sets it. */
  workerEntry?: string
}

export type Broker = {
  /** Stops listening, drops open connections, waits for running children, removes the socket. */
  close: () => Promise<void>
}

type Read =
  | { kind: "request"; header: RequestHeader; body: Buffer }
  | { kind: "refused"; sha256: string; reason: FailureReason; detail: string }
  | { kind: "gone" }

const failure = (
  sha256: string,
  reason: FailureReason,
  detail: string
): ParseResult => ({ ok: false, sha256, reason, detail })

/**
 * Reads one request from the socket: the header first, then the body. An oversize body is
 * refused as soon as the header is read, and nothing after the header is read or kept.
 */
function readRequest(socket: Socket, timeoutMs: number): Promise<Read> {
  return new Promise((resolve) => {
    let head = Buffer.alloc(0)
    let header: RequestHeader | null = null
    const body: Buffer[] = []
    let bodyLength = 0
    let settled = false

    const finish = (read: Read) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off("data", onData)
      socket.off("end", onEnd)
      socket.off("close", onClose)
      // No more bytes are read from this client.
      socket.pause()
      resolve(read)
    }
    const refuse = (
      reason: FailureReason,
      detail: string,
      sha256 = NO_SHA256
    ) => finish({ kind: "refused", sha256, reason, detail })
    const timer = setTimeout(
      () => refuse("malformed", "the request was not completed in time"),
      timeoutMs
    )
    const onClose = () => finish({ kind: "gone" })
    const onEnd = () =>
      refuse(
        "malformed",
        "the request ended before its last byte",
        header?.sha256
      )
    const onData = (incoming: Buffer) => {
      let chunk = incoming
      if (header === null) {
        head = Buffer.concat([head, chunk])
        if (head.length < 4) return
        const headerBytes = head.readUInt32BE(0)
        if (headerBytes === 0 || headerBytes > MAX_HEADER_BYTES) {
          refuse("malformed", "the request header has an invalid length")
          return
        }
        if (head.length < 4 + headerBytes) return
        header = readRequestHeader(head.subarray(4, 4 + headerBytes))
        if (header === null) {
          refuse("malformed", "the request header is not valid")
          return
        }
        if (header.bodyBytes > header.limits.inputBytes) {
          refuse(
            "oversize",
            `${String(header.bodyBytes)} bytes, more than ${String(header.limits.inputBytes)}`,
            header.sha256
          )
          return
        }
        chunk = head.subarray(4 + headerBytes)
        head = Buffer.alloc(0)
      }
      body.push(chunk)
      bodyLength += chunk.length
      if (bodyLength > header.bodyBytes) {
        refuse(
          "malformed",
          "the request has more bytes than its header declares",
          header.sha256
        )
      } else if (bodyLength === header.bodyBytes) {
        finish({ kind: "request", header, body: Buffer.concat(body) })
      }
    }
    socket.on("data", onData)
    socket.once("end", onEnd)
    socket.once("close", onClose)
  })
}

function respond(socket: Socket, result: ParseResult): void {
  if (socket.destroyed) return
  socket.end(frame(Buffer.from(JSON.stringify(result), "utf8")))
  // The client reads the whole frame and hangs up; this only frees a client that does not.
  const grace = setTimeout(() => socket.destroy(), RESPONSE_GRACE_MS)
  grace.unref()
  socket.once("close", () => clearTimeout(grace))
}

/** Whether something is accepting connections on the socket at `path`. */
function isListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)
    probe.once("connect", () => {
      probe.destroy()
      resolve(true)
    })
    probe.once("error", () => {
      probe.destroy()
      resolve(false)
    })
  })
}

/**
 * Removes a leftover socket file of a broker that died. It refuses to remove anything else,
 * and a socket that a running broker still listens on.
 */
async function clearStaleSocket(path: string): Promise<void> {
  let isSocket: boolean
  try {
    isSocket = lstatSync(path).isSocket()
  } catch {
    return
  }
  if (!isSocket) throw new Error("the broker's socket path is not a socket")
  if (await isListening(path)) {
    throw new Error("another broker is already listening on the socket path")
  }
  unlinkSync(path)
}

export async function startBroker(config: BrokerConfig): Promise<Broker> {
  const limit = createLimiter(config.maxConcurrent ?? 2)
  const entry = config.workerEntry ?? WORKER
  const requestTimeoutMs = config.requestTimeoutMs ?? 30_000
  preparePrivateScratchRoot(config.scratchDir)
  await clearStaleSocket(config.socketPath)

  const sockets = new Set<Socket>()
  const jobs = new Set<Promise<void>>()
  let closing = false

  async function runJob(
    header: RequestHeader,
    body: Buffer,
    clientGone: () => boolean
  ): Promise<ParseResult> {
    const { sha256, limits, mime } = header
    try {
      const actual = createHash("sha256").update(body).digest("hex")
      if (actual !== sha256) {
        return failure(sha256, "malformed", "the body does not match its hash")
      }
      const outcome = await limit(async () => {
        // A job that queued while its client left, or while the broker closed, never starts.
        if (closing || clientGone()) return null
        const workDir = createPrivateWorkDirectory(config.scratchDir)
        try {
          const path = join(workDir, "original")
          writeFileSync(path, body, { flag: "wx", mode: 0o600 })
          const payload: WorkerPayload = {
            blobPath: path,
            sha256,
            mime,
            limits,
            ocrBinary: config.ocrBinary ?? null,
          }
          return await runInChild({
            entry,
            payload,
            tmpRoot: config.scratchDir,
            limits: {
              timeoutMs: limits.timeoutMs,
              heapMiB: limits.heapMiB,
              resultBytes: maxResponseBytes(limits),
            },
          })
        } finally {
          rmSync(workDir, { recursive: true, force: true })
        }
      })
      if (outcome === null) {
        return failure(sha256, "crashed", "the parse was cancelled")
      }
      if (!outcome.ok) {
        return failure(sha256, outcome.reason, outcome.detail)
      }
      return readParseResult(outcome.value, sha256, limits)
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown"
      return failure(sha256, "crashed", `the parse could not run (${name})`)
    }
  }

  async function handle(socket: Socket): Promise<void> {
    let gone = false
    socket.once("close", () => {
      gone = true
    })
    // A reset or a broken pipe is that client's problem; it must never reach the process.
    socket.on("error", () => undefined)
    const read = await readRequest(socket, requestTimeoutMs)
    if (read.kind === "gone") return
    if (read.kind === "request") {
      // The client keeps its side open until it has the answer, so its hangup means it left.
      // Anything else it sends after the request is dropped unread.
      socket.once("end", () => socket.destroy())
      socket.resume()
    }
    const result =
      read.kind === "refused"
        ? failure(read.sha256, read.reason, read.detail)
        : await runJob(read.header, read.body, () => gone)
    respond(socket, result)
  }

  // Half-open: a client that ends its writing side early still gets its answer.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    const job = handle(socket)
      .catch(() => {
        socket.destroy()
      })
      .finally(() => jobs.delete(job))
    jobs.add(job)
  })
  // Anything the server itself reports after it is listening is not a reason to stop serving.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(config.socketPath, () => {
      server.off("error", reject)
      server.on("error", () => undefined)
      resolve()
    })
  })
  chmodSync(config.socketPath, config.socketMode ?? 0o660)

  return {
    close: async () => {
      closing = true
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve())
      )
      for (const socket of sockets) socket.destroy()
      await closed
      await Promise.allSettled([...jobs])
    },
  }
}
