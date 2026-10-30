import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

// Test support, not a runtime fallback: production code never starts or falls back to this.
// It speaks the subset of llama-server the client uses, so tests and Windows development run
// with no model:
// - `GET /health`, answering ready;
// - `GET /props` with `default_generation_settings.n_ctx`;
// - `GET /v1/models` with one model id;
// - `POST /apply-template`, rendering a ChatML template (tools in the system turn);
// - `POST /tokenize`, a byte tokenizer: ids 0-255 are UTF-8 bytes, and with `parse_special`
//   the control-token strings of common chat formats become ids from 256 up;
// - `POST /completion` with a token-id prompt, streamed with `stop`, `stop_type` and
//   `tokens_evaluated`.

/** Control-token strings of ChatML, Llama 3, Gemma and Mistral, with ids from 256 up. */
export const SPECIAL_TOKENS = [
  "<|im_start|>",
  "<|im_end|>",
  "<|begin_of_text|>",
  "<|start_header_id|>",
  "<|end_header_id|>",
  "<|eot_id|>",
  "<start_of_turn>",
  "<end_of_turn>",
  "[INST]",
  "[/INST]",
  "<s>",
  "</s>",
] as const

export type SpecialToken = (typeof SPECIAL_TOKENS)[number]

const SPECIAL_BASE = 256

/** The id `/tokenize` gives a control-token string when `parse_special` is on. */
export function specialId(token: SpecialToken): number {
  return SPECIAL_BASE + SPECIAL_TOKENS.indexOf(token)
}

/** The BOS id `add_special` prepends. */
export const BOS_ID = specialId("<s>")

/** One scripted answer to a completion request. */
export interface StubReply {
  /** HTTP status. Default 200; anything else answers with a JSON error body. */
  status?: number
  /** Content pieces, one SSE chunk each. Default: none. */
  deltas?: string[]
  /** Optional aligned probability for each generated token spelling. */
  probabilities?: { token: string; probability: number }[]
  /** Raw byte variant for malformed UTF-8 metadata cases. */
  probabilityBytes?: { bytes: number[]; probability: number }[]
  /** Reported `tokens_evaluated`. Default: the prompt's length. Null leaves it out. */
  promptTokens?: number | null
  /** "stop" (eos), "length" (limit), or any other `stop_type` sent as is. Default "stop". */
  finishReason?: string
  /**
   * Characters to split inside: for each, the body is written in two parts that break after
   * the first UTF-8 byte of its first occurrence, so the client sees a sequence cut in two.
   */
  splitInside?: string[]
  /** Send the first piece, then keep the stream open until the client goes away. */
  hang?: boolean
  /** Called after the first streaming chunk is written; test synchronization only. */
  onFirstChunk?: () => void
  /** Replaces the whole streamed body, for malformed-stream tests. */
  rawBody?: string
}

export interface StubScript {
  /** Listen on this 127.0.0.1 port. Default: a free one. */
  port?: number
  /** `/v1/models` reports this id. Default "local". */
  modelId?: string
  /** `/props` reports this as `default_generation_settings.n_ctx`. Default 4096. */
  contextTokens?: number
  /** Request n gets reply n; requests past the end get the last one. */
  replies: StubReply[]
  /** Routes this server lacks: they answer 404, as an older llama-server would. */
  missing?: ("apply-template" | "tokenize")[]
  /** Number of initial `/v1/models` requests that return an error. */
  modelMetadataFailures?: number
  /** `/tokenize` parses special tokens whatever `parse_special` says. */
  ignoreParseSpecial?: boolean
  /** Rewrites the `/apply-template` answer's prompt, for template tests. */
  renderedPrompt?: (prompt: string) => string
}

export interface RecordedRequest {
  method: string
  path: string
  /** The raw body as received. */
  body: string
}

/** One `/completion` request as the stub read it. */
export interface CompletionView {
  /** The prompt's token ids, as sent. */
  tokens: number[]
  /** The rest of the body. */
  body: Record<string, unknown>
  /** The chat turns, split on the control-token ids only (never on text). */
  turns: { role: string; content: string }[]
}

export interface StubModelServer {
  /** `http://127.0.0.1:<port>` */
  url: string
  /** Every request received, in order. */
  requests: RecordedRequest[]
  /** Every `/completion` request, parsed. */
  completions(): CompletionView[]
  close(): Promise<void>
}

const encoder = new TextEncoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Ids for `content`: bytes, and control-token strings as their ids when `parseSpecial`. */
export function stubTokenize(
  content: string,
  addSpecial: boolean,
  parseSpecial: boolean
): number[] {
  const ids: number[] = addSpecial ? [BOS_ID] : []
  let text = ""
  const flush = (): void => {
    ids.push(...encoder.encode(text))
    text = ""
  }
  let i = 0
  outer: while (i < content.length) {
    if (parseSpecial) {
      for (const [index, token] of SPECIAL_TOKENS.entries()) {
        if (content.startsWith(token, i)) {
          flush()
          ids.push(SPECIAL_BASE + index)
          i += token.length
          continue outer
        }
      }
    }
    text += content.charAt(i)
    i += 1
  }
  flush()
  return ids
}

/** The text of byte ids; a control-token id is written as its string. */
export function stubDecode(tokens: readonly number[]): string {
  const decoder = new TextDecoder()
  let text = ""
  let bytes: number[] = []
  for (const id of tokens) {
    if (id < SPECIAL_BASE) {
      bytes.push(id)
      continue
    }
    text += decoder.decode(new Uint8Array(bytes))
    bytes = []
    text += SPECIAL_TOKENS[id - SPECIAL_BASE] ?? `<unk ${String(id)}>`
  }
  return text + decoder.decode(new Uint8Array(bytes))
}

/** The ChatML turns of a prompt, cut at the `<|im_start|>` and `<|im_end|>` ids. */
export function chatTurns(
  tokens: readonly number[]
): { role: string; content: string }[] {
  const start = specialId("<|im_start|>")
  const end = specialId("<|im_end|>")
  const turns: { role: string; content: string }[] = []
  let current: number[] | null = null
  for (const id of tokens) {
    if (id === start) {
      current = []
      continue
    }
    if (id === end && current !== null) {
      const text = stubDecode(current)
      const newline = text.indexOf("\n")
      turns.push({
        role: text.slice(0, newline),
        content: text.slice(newline + 1),
      })
      current = null
      continue
    }
    current?.push(id)
  }
  return turns
}

/** ChatML, with the tool list in the system turn, ending on an open assistant turn. */
export function renderChatTemplate(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    throw new Error("apply-template body has no messages")
  }
  const tools =
    body.tools === undefined ? "" : `\n\n# Tools\n${JSON.stringify(body.tools)}`
  const turns = body.messages.map((message: unknown, i) => {
    if (
      !isRecord(message) ||
      typeof message.role !== "string" ||
      typeof message.content !== "string"
    ) {
      throw new Error("apply-template message is malformed")
    }
    const extra = i === 0 && message.role === "system" ? tools : ""
    return `<|im_start|>${message.role}\n${message.content}${extra}<|im_end|>\n`
  })
  return `${turns.join("")}<|im_start|>assistant\n`
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

const STOP_TYPE: Record<string, string> = { stop: "eos", length: "limit" }

/** The SSE body llama-server would stream for `reply` to a prompt of `promptLength` ids. */
export function streamBody(reply: StubReply, promptLength = 0): string {
  if (reply.rawBody !== undefined) return reply.rawBody
  const parts = (reply.deltas ?? []).map((content) =>
    sse({ content, stop: false })
  )
  const finish = reply.finishReason ?? "stop"
  parts.push(
    sse({
      content: "",
      stop: true,
      stop_type: STOP_TYPE[finish] ?? finish,
      ...(reply.promptTokens === null
        ? {}
        : { tokens_evaluated: reply.promptTokens ?? promptLength }),
    })
  )
  return parts.join("")
}

function completionJson(reply: StubReply, promptLength: number): unknown {
  const content = (reply.deltas ?? []).join("")
  const finish = reply.finishReason ?? "stop"
  return {
    content,
    stop: true,
    stop_type: STOP_TYPE[finish] ?? finish,
    tokens_evaluated: reply.promptTokens ?? promptLength,
    ...(reply.probabilities === undefined &&
    reply.probabilityBytes === undefined
      ? {}
      : {
          completion_probabilities: (
            reply.probabilityBytes ??
            reply.probabilities?.map(({ token, probability }) => ({
              bytes: [...encoder.encode(token)],
              probability,
            })) ??
            []
          ).map(({ bytes, probability }) => ({
            bytes,
            logprob: Math.log(probability),
            token: new TextDecoder().decode(new Uint8Array(bytes)),
            top_logprobs: [
              {
                token: "decoy",
                bytes: [100, 101, 99, 111, 121],
                logprob: -0.0001,
              },
            ],
          })),
        }),
  }
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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: { code: 404, message: "not found" } })
}

async function writeReply(
  res: ServerResponse,
  reply: StubReply,
  promptLength: number,
  streaming: boolean
): Promise<void> {
  const status = reply.status ?? 200
  if (status < 200 || status > 299) {
    json(res, status, { error: { code: status, message: "stub error" } })
    return
  }
  if (!streaming) {
    json(res, status, completionJson(reply, promptLength))
    return
  }
  res.writeHead(status, { "content-type": "text/event-stream" })
  res.flushHeaders()
  if (reply.hang === true) {
    res.write(sse({ content: reply.deltas?.[0] ?? "", stop: false }))
    reply.onFirstChunk?.()
    return
  }
  const pieces = splitBytes(
    encoder.encode(streamBody(reply, promptLength)),
    reply.splitInside ?? []
  )
  for (const [i, piece] of pieces.entries()) {
    // A pause between writes makes each piece reach the client as its own chunk.
    if (i > 0) await pause(20)
    res.write(piece)
  }
  res.end()
}

/** A `/completion` body read back: the token-id prompt and the other fields. */
export function parseCompletion(raw: string): CompletionView {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || !Array.isArray(parsed.prompt)) {
    throw new Error("completion body has no prompt array")
  }
  const tokens = parsed.prompt.filter((t): t is number => typeof t === "number")
  if (tokens.length !== parsed.prompt.length) {
    throw new Error("completion prompt holds something other than token ids")
  }
  const body = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== "prompt")
  )
  return { tokens, body, turns: chatTurns(tokens) }
}

/** Starts a scripted llama-server stand-in on 127.0.0.1 with a free port. */
export async function startStubModelServer(
  script: StubScript
): Promise<StubModelServer> {
  const requests: RecordedRequest[] = []
  const missing = new Set(script.missing ?? [])
  let modelMetadataFailures = script.modelMetadataFailures ?? 0
  let completions = 0
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    const body = await readBody(req)
    const path = req.url ?? "/"
    requests.push({ method: req.method ?? "", path, body })
    if (req.method === "GET" && path === "/health") {
      json(res, 200, { status: "ok" })
      return
    }
    if (req.method === "GET" && path === "/props") {
      json(res, 200, {
        default_generation_settings: { n_ctx: script.contextTokens ?? 4096 },
        total_slots: 1,
      })
      return
    }
    if (req.method === "GET" && path === "/v1/models") {
      if (modelMetadataFailures > 0) {
        modelMetadataFailures -= 1
        json(res, 503, { error: { message: "metadata unavailable" } })
        return
      }
      json(res, 200, { data: [{ id: script.modelId ?? "local" }] })
      return
    }
    if (req.method !== "POST") return notFound(res)
    if (path === "/apply-template" && !missing.has("apply-template")) {
      const prompt = renderChatTemplate(JSON.parse(body))
      json(res, 200, { prompt: script.renderedPrompt?.(prompt) ?? prompt })
      return
    }
    if (path === "/tokenize" && !missing.has("tokenize")) {
      const parsed: unknown = JSON.parse(body)
      if (!isRecord(parsed) || typeof parsed.content !== "string") {
        json(res, 400, { error: { code: 400, message: "no content" } })
        return
      }
      json(res, 200, {
        tokens: stubTokenize(
          parsed.content,
          parsed.add_special === true,
          script.ignoreParseSpecial === true || parsed.parse_special !== false
        ),
      })
      return
    }
    if (path === "/completion") {
      const index = Math.min(completions, script.replies.length - 1)
      completions += 1
      const reply = script.replies[index]
      if (reply !== undefined) {
        await writeReply(
          res,
          reply,
          parseCompletion(body).tokens.length,
          parseCompletion(body).body.stream !== false ||
            reply.rawBody !== undefined ||
            reply.hang === true
        )
        return
      }
    }
    notFound(res)
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      json(res, 500, {
        error: {
          code: 500,
          message: error instanceof Error ? error.message : "stub failure",
        },
      })
    })
  })
  server.on("connection", (socket) => socket.setNoDelay(true))
  await new Promise<void>((resolve) =>
    server.listen(script.port ?? 0, "127.0.0.1", resolve)
  )
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    completions: () =>
      requests
        .filter((r) => r.path === "/completion")
        .map((r) => parseCompletion(r.body)),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
