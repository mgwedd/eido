import {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_MARGIN_RATIO,
  assertFits,
  estimateTokens,
  truncationSuspected,
} from "./budget"
import { InferenceError, UnsupportedModelServerError } from "./errors"
import type { RequiredServerFeature } from "./errors"
import { newBoundary } from "./fence"
import { buildCompletionBody, buildTemplateBody, promptText } from "./request"
import {
  applyEvent,
  finishStream,
  initialStreamState,
  splitEvents,
} from "./stream"
import type {
  CompleteOptions,
  InferenceRequest,
  InferenceResult,
  ModelClient,
  ModelClientDeps,
  ModelServerConfig,
} from "./types"

export const DEFAULT_TRIPWIRE_RATIO = 0.6
export const DEFAULT_TRIPWIRE_MIN_PROMPT_TOKENS = 500

// `URL.hostname` keeps the brackets around an IPv6 address.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]", "localhost"])

/** `baseUrl` without a trailing slash; throws unless it is http(s) on a loopback host. */
export function loopbackBaseUrl(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch (cause) {
    throw new Error(
      `model server baseUrl ${JSON.stringify(baseUrl)} is not a URL`,
      {
        cause,
      }
    )
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `model server baseUrl must be http or https, not ${url.protocol}`
    )
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error(
      `inference is local: model server baseUrl must be 127.0.0.1, ::1 or localhost, not ${url.hostname}`
    )
  }
  // A loop, not /\/+$/: that regex backtracks quadratically on a long run of slashes.
  let end = baseUrl.length
  while (baseUrl[end - 1] === "/") end -= 1
  return baseUrl.slice(0, end)
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `${name} must be a positive number, not ${String(value)}`
    )
  }
  return value
}

function ratio(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(
      `${name} must be between 0 and 1, not ${String(value)}`
    )
  }
  return value
}

// Cancelling a body or reader that already failed rejects with that failure; it is reported
// through the error thrown next, so the rejection itself carries nothing new.
function ignore(): void {}

function abortedError(cause: unknown): InferenceError {
  return new InferenceError("aborted", null, "inference request aborted", {
    cause,
  })
}

async function post(
  doFetch: typeof fetch,
  url: string,
  body: string,
  signal: AbortSignal | undefined
): Promise<Response> {
  try {
    return await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    })
  } catch (cause) {
    if (signal?.aborted === true) throw abortedError(cause)
    throw new InferenceError("unreachable", null, "model server unreachable", {
      cause,
    })
  }
}

async function readStream(
  response: Response,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined
): Promise<ReturnType<typeof finishStream>> {
  const status = response.status
  const reader = body.getReader()
  // One decoder over every byte of the body: `stream: true` holds back a UTF-8 sequence split
  // across chunks until its remaining bytes arrive. `fatal` rejects invalid UTF-8.
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const state = initialStreamState()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true })
      const { events, rest } = splitEvents(buffer)
      buffer = rest
      for (const event of events) applyEvent(state, event, status)
      if (done) break
    }
    if (buffer.trim() !== "") applyEvent(state, buffer, status)
    return finishStream(state, status)
  } catch (cause) {
    await reader.cancel().catch(ignore)
    if (cause instanceof InferenceError) throw cause
    if (signal?.aborted === true) throw abortedError(cause)
    throw new InferenceError("malformed", status, "could not read the stream", {
      cause,
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// A route llama-server does not have answers 404 (or 405/501 behind some proxies).
const MISSING_ROUTE = new Set([404, 405, 501])

const ENDPOINT: Record<
  Exclude<RequiredServerFeature, "parse_special">,
  string
> = {
  "apply-template": "/apply-template",
  tokenize: "/tokenize",
}

async function postJson(
  doFetch: typeof fetch,
  baseUrl: string,
  feature: "apply-template" | "tokenize",
  body: string,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>> {
  const path = ENDPOINT[feature]
  const response = await post(doFetch, `${baseUrl}${path}`, body, signal)
  if (!response.ok) {
    await response.body?.cancel().catch(ignore)
    if (MISSING_ROUTE.has(response.status)) {
      throw new UnsupportedModelServerError(
        feature,
        `model server has no ${path} (answered ${String(response.status)}): inference needs it to keep material out of the special-token parser`
      )
    }
    throw new InferenceError(
      "http",
      response.status,
      `model server answered ${String(response.status)} on ${path}`
    )
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (cause) {
    if (signal?.aborted === true) throw abortedError(cause)
    throw new InferenceError(
      "malformed",
      response.status,
      `${path} answer is not JSON`,
      { cause }
    )
  }
  if (!isRecord(parsed)) {
    throw new InferenceError(
      "malformed",
      response.status,
      `${path} answer is not an object`
    )
  }
  return parsed
}

/** The chat template rendered by the server, with placeholders where material goes. */
async function applyTemplate(
  doFetch: typeof fetch,
  baseUrl: string,
  body: string,
  signal: AbortSignal | undefined
): Promise<string> {
  const answer = await postJson(
    doFetch,
    baseUrl,
    "apply-template",
    body,
    signal
  )
  if (typeof answer.prompt !== "string") {
    throw new InferenceError(
      "malformed",
      200,
      "/apply-template answer has no prompt"
    )
  }
  return answer.prompt
}

interface TokenizeArgs {
  /** Prepend the model's BOS token. Only the first trusted piece sets it. */
  addSpecial: boolean
  /** Turn special-token text into control tokens. Never set for material. */
  parseSpecial: boolean
}

async function tokenize(
  doFetch: typeof fetch,
  baseUrl: string,
  content: string,
  args: TokenizeArgs,
  signal: AbortSignal | undefined
): Promise<number[]> {
  const answer = await postJson(
    doFetch,
    baseUrl,
    "tokenize",
    JSON.stringify({
      content,
      add_special: args.addSpecial,
      parse_special: args.parseSpecial,
    }),
    signal
  )
  const tokens = answer.tokens
  if (
    !Array.isArray(tokens) ||
    !tokens.every(
      (t): t is number => typeof t === "number" && Number.isInteger(t) && t >= 0
    )
  ) {
    throw new InferenceError(
      "malformed",
      200,
      "/tokenize answer has no list of token ids"
    )
  }
  return tokens
}

// A private-use character no template writes, around a per-request nonce.
const MARK = "\u{F8FF}"

/** What stands in for span `index` in the template body. */
export function placeholder(nonce: string, index: number): string {
  return `${MARK}eido:${nonce}:${String(index)}${MARK}`
}

/**
 * The rendered prompt cut at its placeholders: trusted pieces around the spans, in order. Each
 * placeholder must appear exactly once and in order, or the template changed something it must
 * not have, and nothing is sent.
 */
export function splitRendered(
  rendered: string,
  nonce: string,
  spanCount: number
): string[] {
  const pieces: string[] = []
  let cursor = 0
  let expected = 0
  const marks = new RegExp(`${MARK}eido:${nonce}:(\\d+)${MARK}`, "gu")
  for (const match of rendered.matchAll(marks)) {
    if (match[1] !== String(expected)) {
      throw new InferenceError(
        "malformed",
        200,
        "the rendered template does not hold each material placeholder once, in order"
      )
    }
    pieces.push(rendered.slice(cursor, match.index))
    cursor = match.index + match[0].length
    expected += 1
  }
  if (expected !== spanCount) {
    throw new InferenceError(
      "malformed",
      200,
      "the rendered template does not hold each material placeholder once, in order"
    )
  }
  pieces.push(rendered.slice(cursor))
  return pieces
}

/**
 * The prompt as token ids. Trusted pieces (template, system prompt, owner words, block tags) are
 * tokenized with special tokens on; every material span alone with `parse_special: false`, so
 * no text inside material can become a control token. The first piece carries the BOS token,
 * which the server strips from the rendered template.
 */
async function promptTokens(
  doFetch: typeof fetch,
  baseUrl: string,
  pieces: readonly string[],
  spans: readonly string[],
  signal: AbortSignal | undefined
): Promise<number[]> {
  const ids: number[] = []
  for (const [i, piece] of pieces.entries()) {
    if (i === 0 || piece !== "") {
      ids.push(
        ...(await tokenize(
          doFetch,
          baseUrl,
          piece,
          { addSpecial: i === 0, parseSpecial: true },
          signal
        ))
      )
    }
    const span = spans[i]
    if (span === undefined || span === "") continue
    ids.push(
      ...(await tokenize(
        doFetch,
        baseUrl,
        span,
        { addSpecial: false, parseSpecial: false },
        signal
      ))
    )
  }
  return ids
}

/**
 * A client for one loopback llama-server. It refuses oversized prompts and never retries. Each
 * request renders the chat template with `/apply-template`, tokenizes with `/tokenize` and sends
 * token ids to `/completion`; a server without those routes fails with
 * `UnsupportedModelServerError` before any prompt is sent. Use `connectModelClient` at startup.
 */
export function createModelClient(
  config: ModelServerConfig,
  deps: ModelClientDeps = {}
): ModelClient {
  const baseUrl = loopbackBaseUrl(config.baseUrl)
  const contextTokens = positive("contextTokens", config.contextTokens)
  const maxReplyTokens = positive("maxReplyTokens", config.maxReplyTokens)
  const marginRatio = ratio(
    "marginRatio",
    config.marginRatio ?? DEFAULT_MARGIN_RATIO
  )
  const charsPerToken = positive(
    "charsPerToken",
    config.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  )
  const tripwireRatio = ratio(
    "tripwireRatio",
    config.tripwireRatio ?? DEFAULT_TRIPWIRE_RATIO
  )
  const tripwireMin =
    config.tripwireMinPromptTokens ?? DEFAULT_TRIPWIRE_MIN_PROMPT_TOKENS
  const doFetch = deps.fetch ?? fetch

  return {
    async complete(
      req: InferenceRequest,
      opts: CompleteOptions = {}
    ): Promise<InferenceResult> {
      const maxTokens = req.maxTokens ?? maxReplyTokens
      // A fresh boundary per request: no material can know another request's.
      const boundary = newBoundary()
      const estimatedPromptTokens = estimateTokens(
        promptText(req, boundary),
        charsPerToken
      )
      // Refuse, don't truncate: nothing is sent, and the input is never shortened to fit.
      assertFits(estimatedPromptTokens, maxTokens, contextTokens, marginRatio)

      const nonce = newBoundary()
      const spans: string[] = []
      const templateBody = buildTemplateBody(req, boundary, (span) => {
        const mark = placeholder(nonce, spans.length)
        spans.push(span)
        return mark
      })
      const rendered = await applyTemplate(
        doFetch,
        baseUrl,
        templateBody,
        opts.signal
      )
      const pieces = splitRendered(rendered, nonce, spans.length)
      const tokens = await promptTokens(
        doFetch,
        baseUrl,
        pieces,
        spans,
        opts.signal
      )

      const response = await post(
        doFetch,
        `${baseUrl}/completion`,
        buildCompletionBody(req, tokens, maxTokens),
        opts.signal
      )
      if (!response.ok) {
        await response.body?.cancel().catch(ignore)
        throw new InferenceError(
          "http",
          response.status,
          `model server answered ${String(response.status)}`
        )
      }
      if (response.body === null) {
        throw new InferenceError(
          "malformed",
          response.status,
          "response has no body"
        )
      }
      const streamed = await readStream(response, response.body, opts.signal)
      return {
        text: streamed.text,
        estimatedPromptTokens,
        reportedPromptTokens: streamed.promptTokens,
        truncationSuspected: truncationSuspected(
          estimatedPromptTokens,
          streamed.promptTokens,
          tripwireRatio,
          tripwireMin
        ),
        finishReason: streamed.finishReason,
      }
    },
  }
}

const PROBE_TEXT = "probe"

/**
 * Checks the server at startup, then returns a client for it. It needs `/apply-template` and
 * `/tokenize`, and `/tokenize` must honour `parse_special`: the rendered probe template must
 * tokenize differently with special tokens off. Otherwise it throws
 * `UnsupportedModelServerError` naming what is missing, and no prompt is ever sent.
 */
export async function connectModelClient(
  config: ModelServerConfig,
  deps: ModelClientDeps & { signal?: AbortSignal } = {}
): Promise<ModelClient> {
  const baseUrl = loopbackBaseUrl(config.baseUrl)
  const doFetch = deps.fetch ?? fetch
  const rendered = await applyTemplate(
    doFetch,
    baseUrl,
    JSON.stringify({
      messages: [
        { role: "system", content: PROBE_TEXT },
        { role: "user", content: PROBE_TEXT },
      ],
    }),
    deps.signal
  )
  const special = await tokenize(
    doFetch,
    baseUrl,
    rendered,
    { addSpecial: false, parseSpecial: true },
    deps.signal
  )
  const literal = await tokenize(
    doFetch,
    baseUrl,
    rendered,
    { addSpecial: false, parseSpecial: false },
    deps.signal
  )
  if (
    special.length === literal.length &&
    special.every((id, i) => id === literal[i])
  ) {
    throw new UnsupportedModelServerError(
      "parse_special",
      "model server /tokenize ignores parse_special: the chat template's control tokens tokenize the same either way"
    )
  }
  return createModelClient(config, deps)
}

/**
 * The context size llama-server reports in `GET /props` (`default_generation_settings.n_ctx`).
 * Read it at startup and again after a reconnect, and pass it as `contextTokens`.
 */
export async function readContextTokens(
  baseUrl: string,
  deps: ModelClientDeps & { signal?: AbortSignal } = {}
): Promise<number> {
  const url = `${loopbackBaseUrl(baseUrl)}/props`
  const doFetch = deps.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(url, { signal: deps.signal })
  } catch (cause) {
    if (deps.signal?.aborted === true) throw abortedError(cause)
    throw new InferenceError("unreachable", null, "model server unreachable", {
      cause,
    })
  }
  if (!response.ok) {
    await response.body?.cancel().catch(ignore)
    throw new InferenceError(
      "http",
      response.status,
      `model server answered ${String(response.status)}`
    )
  }
  let props: unknown
  try {
    props = await response.json()
  } catch (cause) {
    throw new InferenceError(
      "malformed",
      response.status,
      "props is not JSON",
      {
        cause,
      }
    )
  }
  const settings = isRecord(props)
    ? props.default_generation_settings
    : undefined
  const nCtx = isRecord(settings) ? settings.n_ctx : undefined
  if (typeof nCtx !== "number" || !Number.isInteger(nCtx) || nCtx <= 0) {
    throw new InferenceError(
      "malformed",
      response.status,
      "props has no positive default_generation_settings.n_ctx"
    )
  }
  return nCtx
}
