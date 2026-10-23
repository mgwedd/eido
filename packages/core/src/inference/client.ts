import {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_MARGIN_RATIO,
  assertFits,
  estimateTokens,
  truncationSuspected,
} from "./budget"
import { InferenceError } from "./errors"
import { buildChatBody, promptText } from "./request"
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
  return baseUrl.replace(/\/+$/, "")
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

/** A client for one loopback llama-server. It refuses oversized prompts and never retries. */
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
  const url = `${baseUrl}/v1/chat/completions`

  return {
    async complete(
      req: InferenceRequest,
      opts: CompleteOptions = {}
    ): Promise<InferenceResult> {
      const maxTokens = req.maxTokens ?? maxReplyTokens
      const estimatedPromptTokens = estimateTokens(
        promptText(req),
        charsPerToken
      )
      // Refuse, don't truncate: nothing is sent, and the input is never shortened to fit.
      assertFits(estimatedPromptTokens, maxTokens, contextTokens, marginRatio)

      const response = await post(
        doFetch,
        url,
        buildChatBody(req, maxTokens),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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
