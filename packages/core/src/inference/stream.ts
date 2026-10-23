import { InferenceError } from "./errors"
import type { FinishReason } from "./types"

// llama-server streams `/v1/chat/completions` as server-sent events: one
// `chat.completion.chunk` per content delta, a chunk carrying `finish_reason`, a chunk with
// `usage` (stream_options.include_usage), then `data: [DONE]`.

export interface StreamState {
  text: string
  finishReason: FinishReason | null
  promptTokens: number | null
  done: boolean
}

export function initialStreamState(): StreamState {
  return { text: "", finishReason: null, promptTokens: null, done: false }
}

/** Complete events in `buffer` (separated by a blank line), and the incomplete rest. */
export function splitEvents(buffer: string): {
  events: string[]
  rest: string
} {
  const boundary = /\r?\n\r?\n/g
  const events: string[] = []
  let start = 0
  for (const match of buffer.matchAll(boundary)) {
    events.push(buffer.slice(start, match.index))
    start = match.index + match[0].length
  }
  return { events, rest: buffer.slice(start) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function malformed(status: number, message: string): InferenceError {
  return new InferenceError("malformed", status, message)
}

function applyChunk(state: StreamState, chunk: unknown, status: number): void {
  if (!isRecord(chunk)) throw malformed(status, "stream chunk is not an object")
  if ("error" in chunk) {
    const error = chunk.error
    const message =
      isRecord(error) && typeof error.message === "string"
        ? error.message
        : "server reported an error in the stream"
    throw malformed(status, message)
  }
  const { choices, usage } = chunk
  if (choices === undefined && usage === undefined) {
    throw malformed(status, "stream chunk has neither choices nor usage")
  }
  if (usage !== undefined && usage !== null) {
    if (!isRecord(usage) || typeof usage.prompt_tokens !== "number") {
      throw malformed(status, "usage.prompt_tokens is missing or not a number")
    }
    state.promptTokens = usage.prompt_tokens
  }
  if (choices === undefined) return
  if (!Array.isArray(choices))
    throw malformed(status, "choices is not an array")
  const choice: unknown = choices[0]
  if (choice === undefined) return
  if (!isRecord(choice)) throw malformed(status, "choice is not an object")
  const { delta, finish_reason: finishReason } = choice
  if (isRecord(delta) && typeof delta.content === "string") {
    state.text += delta.content
  }
  if (finishReason === "stop" || finishReason === "length") {
    state.finishReason = finishReason
  } else if (finishReason !== null && finishReason !== undefined) {
    throw malformed(
      status,
      `finish_reason ${JSON.stringify(finishReason)} is not handled`
    )
  }
}

/** Applies one server-sent event to `state`. */
export function applyEvent(
  state: StreamState,
  event: string,
  status: number
): void {
  for (const line of event.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue // comments, `event:` and `id:` lines
    const data = line.slice("data:".length).trimStart()
    if (state.done) throw malformed(status, "data after [DONE]")
    if (data === "[DONE]") {
      state.done = true
      continue
    }
    let chunk: unknown
    try {
      chunk = JSON.parse(data)
    } catch (cause) {
      throw new InferenceError(
        "malformed",
        status,
        "stream chunk is not JSON",
        {
          cause,
        }
      )
    }
    applyChunk(state, chunk, status)
  }
}

/** The finished stream's result, or a malformed error if it ended early. */
export function finishStream(
  state: StreamState,
  status: number
): { text: string; finishReason: FinishReason; promptTokens: number } {
  if (!state.done) throw malformed(status, "stream ended before [DONE]")
  if (state.finishReason === null) {
    throw malformed(status, "stream carried no finish_reason")
  }
  if (state.promptTokens === null) {
    throw malformed(status, "stream carried no usage.prompt_tokens")
  }
  return {
    text: state.text,
    finishReason: state.finishReason,
    promptTokens: state.promptTokens,
  }
}
