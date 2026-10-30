import type { PromptPart } from "./fence"

// Types for the llama-server client. Inference is local: the client talks to a loopback
// llama-server only, holds no credentials, and never reaches a hosted model API.

/** Where llama-server listens and how big a request may be. Every number comes from config. */
export interface ModelServerConfig {
  /** Must resolve to a loopback host (127.0.0.1, ::1, localhost); anything else throws. */
  baseUrl: string
  /** The server-reported context size in tokens (llama-server `/props`, see `readContextTokens`). */
  contextTokens: number
  /** Tokens reserved for the reply when a request sets no `maxTokens`. */
  maxReplyTokens: number
  /** Safety margin on the whole reservation. Default 0.10. */
  marginRatio?: number
  /** Characters (code points) per estimated token. Default 3. */
  charsPerToken?: number
  /** The tripwire fires when the server reports fewer than this share of the estimate. Default 0.6. */
  tripwireRatio?: number
  /** The tripwire only fires above this estimate. Default 500. */
  tripwireMinPromptTokens?: number
  /**
   * Sent as `chat_template_kwargs` with every `/apply-template` request, where llama-server merges
   * it over its own `--chat-template-kwargs`. For example `{ "enable_thinking": false }` renders a
   * hybrid-thinking template (Qwen 3) with its reasoning turned off. Default: none sent.
   */
  chatTemplateKwargs?: Readonly<Record<string, unknown>>
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool"
  /**
   * Trusted text, or trusted text mixed with fenced material blocks (`fence` in fence.ts). Inbound
   * material is never written into a plain string.
   */
  content: string | readonly PromptPart[]
}

/** An OpenAI-style function tool, as llama-server's chat template expects it. */
export interface ToolDef {
  type: "function"
  function: {
    name: string
    description?: string
    /** JSON Schema for the arguments. */
    parameters?: Record<string, unknown>
  }
}

export interface InferenceRequest {
  /** The stable prefix, identical across requests. */
  system: string
  /** Stable and ordered; part of the prefix. */
  tools?: ToolDef[]
  messages: ChatMessage[]
  /** JSON-schema mode: the server turns the schema into a grammar. */
  jsonSchema?: Record<string, unknown>
  /** Defaults to `maxReplyTokens`. */
  maxTokens?: number
  temperature?: number
  seed?: number
  /** Return token probability metadata; uses llama-server's non-streaming completion response. */
  includeTokenProbabilities?: boolean
}

export type FinishReason = "stop" | "length"

export interface InferenceResult {
  /** Decoded from the accumulated response bytes. */
  text: string
  /** Per-token probabilities, present only when the server returned complete aligned metadata. */
  tokenProbabilities?: readonly {
    bytes: readonly number[]
    probability: number
  }[]
  estimatedPromptTokens: number
  /** `tokens_evaluated` from `/completion`, which includes tokens served from the prompt cache. */
  reportedPromptTokens: number
  truncationSuspected: boolean
  finishReason: FinishReason
}

export interface CompleteOptions {
  signal?: AbortSignal
}

export interface ModelClient {
  complete(
    req: InferenceRequest,
    opts?: CompleteOptions
  ): Promise<InferenceResult>
}

export interface ModelClientDeps {
  fetch?: typeof fetch
}
