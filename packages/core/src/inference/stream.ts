import { InferenceError } from "./errors"
import type { FinishReason } from "./types"

// llama-server streams `POST /completion` as server-sent events: one `data:` chunk per piece of
// content with `stop: false`, then a final chunk with `stop: true`, `stop_type` and
// `tokens_evaluated`. There is no `[DONE]` line on this route.

export interface StreamState {
  text: string
  /** Set by the final chunk. */
  final: { finishReason: FinishReason; promptTokens: number } | null
}

export function initialStreamState(): StreamState {
  return { text: "", final: null }
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

// `limit` is the n_predict cap; `eos` and `word` (a stop string) end the reply normally.
const FINISH: Record<string, FinishReason> = {
  eos: "stop",
  word: "stop",
  limit: "length",
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
  const { content, stop } = chunk
  if (typeof stop !== "boolean") {
    throw malformed(status, "stream chunk has no stop flag")
  }
  if (content !== undefined) {
    if (typeof content !== "string") {
      throw malformed(status, "stream chunk content is not a string")
    }
    state.text += content
  }
  if (!stop) return
  const stopType = chunk.stop_type
  const finish = typeof stopType === "string" ? FINISH[stopType] : undefined
  if (finish === undefined) {
    throw malformed(
      status,
      `stop_type ${JSON.stringify(stopType ?? null)} is not handled`
    )
  }
  const evaluated = chunk.tokens_evaluated
  if (typeof evaluated !== "number") {
    throw malformed(status, "tokens_evaluated is missing or not a number")
  }
  state.final = { finishReason: finish, promptTokens: evaluated }
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
    if (state.final !== null) throw malformed(status, "data after the final chunk")
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
  if (state.final === null)
    throw malformed(status, "stream ended before the final chunk")
  return { text: state.text, ...state.final }
}
