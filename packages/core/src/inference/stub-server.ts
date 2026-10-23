import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

// Test support, not a runtime fallback: production code never starts or falls back to this.
// It speaks the subset of llama-server the client uses (`GET /props`, streamed
// `POST /v1/chat/completions` with `usage.prompt_tokens`) so tests and Windows development run
// with no model.

/** One scripted answer to a chat completion request. */
export interface StubReply {
  /** HTTP status. Default 200; anything else answers with a JSON error body. */
  status?: number
  /** Content deltas, one SSE chunk each. Default: none. */
  deltas?: string[]
  /** Reported `usage.prompt_tokens`. Default 0. Null leaves out the usage chunk. */
  promptTokens?: number | null
  /** Default "stop". */
  finishReason?: string
  /**
   * Characters to split inside: for each, the body is written in two parts that break after
   * the first UTF-8 byte of its first occurrence, so the client sees a sequence cut in two.
   */
  splitInside?: string[]
  /** Send the first delta, then keep the stream open until the client goes away. */
  hang?: boolean
  /** Replaces the whole streamed body, for malformed-stream tests. */
  rawBody?: string
}

export interface StubScript {
  /** `/props` reports this as `default_generation_settings.n_ctx`. Default 4096. */
  contextTokens?: number
  /** Request n gets reply n; requests past the end get the last one. */
  replies: StubReply[]
}

export interface RecordedRequest {
  method: string
  path: string
  /** The raw body as received. */
  body: string
}

export interface StubModelServer {
  /** `http://127.0.0.1:<port>` */
  url: string
  /** Every request received, in order. */
  requests: RecordedRequest[]
  close(): Promise<void>
}

const encoder = new TextEncoder()

function sse(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
}

function chunk(choice: Record<string, unknown>): Record<string, unknown> {
  return {
    object: "chat.completion.chunk",
    choices: [{ index: 0, ...choice }],
  }
}

/** The SSE body llama-server would stream for `reply`. */
export function streamBody(reply: StubReply): string {
  if (reply.rawBody !== undefined) return reply.rawBody
  const parts = (reply.deltas ?? []).map((content) =>
    sse(chunk({ delta: { content }, finish_reason: null }))
  )
  parts.push(
    sse(chunk({ delta: {}, finish_reason: reply.finishReason ?? "stop" }))
  )
  const promptTokens = reply.promptTokens ?? 0
  if (reply.promptTokens !== null) {
    parts.push(
      sse({
        object: "chat.completion.chunk",
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: reply.deltas?.length ?? 0,
          total_tokens: promptTokens + (reply.deltas?.length ?? 0),
        },
      })
    )
  }
  parts.push(sse("[DONE]"))
  return parts.join("")
}

/** `bytes` cut after the first byte of the first occurrence of each of `chars`. */
export function splitBytes(
  bytes: Uint8Array,
  chars: readonly string[]
): Uint8Array[] {
  const cuts = chars
    .map((char) => indexOfBytes(bytes, encoder.encode(char)) + 1)
    .filter((cut) => cut > 0)
    .sort((a, b) => a - b)
  const pieces: Uint8Array[] = []
  let start = 0
  for (const cut of cuts) {
    pieces.push(bytes.subarray(start, cut))
    start = cut
  }
  pieces.push(bytes.subarray(start))
  return pieces
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

async function readBody(req: IncomingMessage): Promise<string> {
  req.setEncoding("utf8")
  let body = ""
  for await (const piece of req) body += String(piece)
  return body
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writeReply(
  res: ServerResponse,
  reply: StubReply
): Promise<void> {
  const status = reply.status ?? 200
  if (status < 200 || status > 299) {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { code: status, message: "stub error" } }))
    return
  }
  res.writeHead(status, { "content-type": "text/event-stream" })
  res.flushHeaders()
  if (reply.hang === true) {
    const first = reply.deltas?.[0] ?? ""
    res.write(sse(chunk({ delta: { content: first }, finish_reason: null })))
    return
  }
  const pieces = splitBytes(
    encoder.encode(streamBody(reply)),
    reply.splitInside ?? []
  )
  for (const [i, piece] of pieces.entries()) {
    // A pause between writes makes each piece reach the client as its own chunk.
    if (i > 0) await pause(20)
    res.write(piece)
  }
  res.end()
}

/** Starts a scripted llama-server stand-in on 127.0.0.1 with a free port. */
export async function startStubModelServer(
  script: StubScript
): Promise<StubModelServer> {
  const requests: RecordedRequest[] = []
  let completions = 0
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req)
      const path = req.url ?? "/"
      requests.push({ method: req.method ?? "", path, body })
      if (req.method === "GET" && path === "/props") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            default_generation_settings: {
              n_ctx: script.contextTokens ?? 4096,
            },
            total_slots: 1,
          })
        )
        return
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const index = Math.min(completions, script.replies.length - 1)
        completions += 1
        const reply = script.replies[index]
        if (reply !== undefined) {
          await writeReply(res, reply)
          return
        }
      }
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { code: 404, message: "not found" } }))
    })()
  })
  server.on("connection", (socket) => socket.setNoDelay(true))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
