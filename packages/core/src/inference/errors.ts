/** The prompt plus the reply reservation and margin do not fit the context. Nothing was sent. */
export class PromptTooLargeError extends Error {
  readonly estimatedPromptTokens: number
  readonly requiredTokens: number
  readonly contextTokens: number

  constructor(
    estimatedPromptTokens: number,
    requiredTokens: number,
    contextTokens: number
  ) {
    super(
      `prompt needs ${String(requiredTokens)} tokens with its reply reservation and margin, ` +
        `the context holds ${String(contextTokens)} (prompt estimate ${String(estimatedPromptTokens)})`
    )
    this.name = "PromptTooLargeError"
    this.estimatedPromptTokens = estimatedPromptTokens
    this.requiredTokens = requiredTokens
    this.contextTokens = contextTokens
  }
}

/**
 * Why a call to llama-server failed:
 * - `http`: the server answered with a non-2xx status.
 * - `malformed`: the body was not the stream or JSON the client expects.
 * - `aborted`: the caller's signal aborted the request.
 * - `unreachable`: no response at all (connection refused, reset).
 */
export type InferenceErrorKind =
  "http" | "malformed" | "aborted" | "unreachable"

/** A failed call to llama-server. The client never retries; retry policy belongs to callers. */
export class InferenceError extends Error {
  readonly kind: InferenceErrorKind
  /** The HTTP status, or null when no response arrived. */
  readonly status: number | null

  constructor(
    kind: InferenceErrorKind,
    status: number | null,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = "InferenceError"
    this.kind = kind
    this.status = status
  }
}

/** What a model server must offer so that no material is parsed for special tokens. */
export type RequiredServerFeature =
  "apply-template" | "tokenize" | "parse_special"

/**
 * The model server lacks `/apply-template` or `/tokenize`, or ignores `parse_special`. Inference
 * refuses to run on it: there is no fallback that sends material as one prompt string.
 */
export class UnsupportedModelServerError extends Error {
  readonly feature: RequiredServerFeature

  constructor(feature: RequiredServerFeature, message: string) {
    super(message)
    this.name = "UnsupportedModelServerError"
    this.feature = feature
  }
}
