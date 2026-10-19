import { chmodSync, lstatSync, unlinkSync } from "node:fs"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { GateApiError } from "@eido/schemas"

// HTTP over a local socket (a Unix domain socket, or a named pipe on Windows). This uses
// node:http, the one exception to "no network libraries beyond fetch": fetch cannot target a
// socket path without a new dependency (ADR 0003). The gate listens on no TCP port.

/** Largest request body the gate reads: 1 MiB. */
export const MAX_BODY_BYTES = 1024 * 1024
// Past this the gate stops draining an oversize body and drops the connection.
const DRAIN_LIMIT_BYTES = 16 * MAX_BODY_BYTES

export type Body = { ok: true; text: string } | { ok: false }

export type GateRequest = {
  method: string
  path: string
  query: URLSearchParams
  /** Reads the body; `ok: false` when it is over MAX_BODY_BYTES. */
  body: () => Promise<Body>
}

export type Reply = { status: number; body: unknown }

export type Handler = (request: GateRequest) => Promise<Reply> | Reply

/** One line per event in the process's own log file: ids, routes and statuses, never bodies. */
export type Log = (
  event: string,
  fields?: Readonly<Record<string, string | number>>
) => void

export function apiError(
  status: number,
  code: GateApiError["code"],
  message: string
): Reply {
  const body: GateApiError = { code, message }
  return { status, body }
}

export const NOT_FOUND: Reply = apiError(404, "not_found", "not found")

/** Reads a body up to `limit` bytes; an oversize body is drained and discarded, not buffered. */
export function readBody(
  request: IncomingMessage,
  limit = MAX_BODY_BYTES
): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > DRAIN_LIMIT_BYTES) {
        request.destroy()
        return
      }
      if (size <= limit) chunks.push(chunk)
    })
    request.on("end", () => {
      resolve(
        size > limit
          ? { ok: false }
          : { ok: true, text: Buffer.concat(chunks).toString("utf8") }
      )
    })
    request.on("error", reject)
    request.on("close", () => {
      if (!request.complete) reject(new Error("request aborted"))
    })
  })
}

function send(response: ServerResponse, reply: Reply): void {
  const text = JSON.stringify(reply.body)
  response.writeHead(reply.status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  })
  response.end(text)
}

/** Wraps a handler: parses the URL, answers every request, and never lets one crash the gate. */
export function createGateServer(
  name: string,
  handler: Handler,
  log: Log
): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://gate.invalid")
    const method = request.method ?? "GET"
    const gateRequest: GateRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: () => readBody(request),
    }
    const answer = async (): Promise<Reply> => {
      try {
        return await handler(gateRequest)
      } catch (error) {
        log("request.failed", {
          listener: name,
          method,
          path: url.pathname,
          error: error instanceof Error ? error.name : "unknown",
        })
        return apiError(500, "unavailable", "the gate could not answer")
      }
    }
    void answer().then((reply) => {
      log("request", {
        listener: name,
        method,
        path: url.pathname,
        status: reply.status,
      })
      if (!response.destroyed) send(response, reply)
    })
  })
}

function removeStaleSocket(path: string): void {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path)
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error
    }
  }
}

/**
 * Listens on a socket path. On macOS and Linux a stale socket file from an earlier run is
 * removed first and the new one gets `mode`; Windows named pipes have neither.
 */
export async function listen(
  server: Server,
  path: string,
  mode: number,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const unix = platform !== "win32"
  if (unix) removeStaleSocket(path)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => {
      server.off("error", reject)
      if (unix) chmodSync(path, mode)
      resolve()
    })
  })
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
    server.closeAllConnections()
  })
}
