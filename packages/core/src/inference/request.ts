import { renderContent } from "./fence"
import type { SpanWriter } from "./fence"
import type { InferenceRequest, ToolDef } from "./types"

// llama-server reuses its KV cache for the longest prompt prefix it has seen (`cache_prompt`).
// The chat template renders the system prompt and the tool list ahead of the conversation, so
// both must serialize byte-identically for equal inputs. The template body is written stable
// part first: `tools`, then `messages` starting with the system message.

/** `value` with object keys sorted at every depth; arrays keep their order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    const entries = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
    for (const [key, entry] of entries) sorted[key] = canonicalize(entry)
    return sorted
  }
  return value
}

/** The tool list as sent: canonical key order, caller's tool order. */
export function serializeTools(tools: readonly ToolDef[]): string {
  return JSON.stringify(canonicalize(tools))
}

/**
 * The text the prompt estimate is taken over: system, tools as JSON, then every message as the
 * model reads it, material blocks included.
 */
export function promptText(req: InferenceRequest, boundary: string): string {
  const tools =
    req.tools !== undefined && req.tools.length > 0
      ? serializeTools(req.tools)
      : ""
  return [
    req.system,
    tools,
    ...req.messages.map((m) => renderContent(m.content, boundary, (s) => s)),
  ].join("")
}

/**
 * The JSON body for `POST /apply-template`, stable prefix first. Each untrusted span is replaced
 * by what `span` returns, so no material reaches the template.
 */
export function buildTemplateBody(
  req: InferenceRequest,
  boundary: string,
  span: SpanWriter
): string {
  const body: Record<string, unknown> = {}
  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = canonicalize(req.tools)
  }
  // Rebuilt field by field so the caller's key order cannot change the bytes.
  body.messages = [
    { role: "system", content: req.system },
    ...req.messages.map((m) => ({
      role: m.role,
      content: renderContent(m.content, boundary, span),
    })),
  ]
  return JSON.stringify(body)
}

/** The JSON body for `POST /completion`: token ids only, so the server adds and parses nothing. */
export function buildCompletionBody(
  req: InferenceRequest,
  tokens: readonly number[],
  maxTokens: number
): string {
  const body: Record<string, unknown> = { prompt: tokens }
  body.n_predict = maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.seed !== undefined) body.seed = req.seed
  if (req.jsonSchema !== undefined) {
    body.json_schema = canonicalize(req.jsonSchema)
  }
  body.stream = true
  body.cache_prompt = true
  return JSON.stringify(body)
}
