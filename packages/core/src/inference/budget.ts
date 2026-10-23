import { PromptTooLargeError } from "./errors"

export const DEFAULT_CHARS_PER_TOKEN = 3
export const DEFAULT_MARGIN_RATIO = 0.1

/** A conservative token estimate: code points divided by `charsPerToken`, rounded up. */
export function estimateTokens(
  text: string,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN
): number {
  // Spreading a string iterates code points, so an astral character counts once.
  return Math.ceil([...text].length / charsPerToken)
}

/**
 * Tokens a request reserves: `ceil((prompt + reply) * (1 + margin))`. The product is rounded to
 * 12 significant digits first, so float noise (110 * 1.1 = 121.00000000000001) does not add a
 * token that the exact arithmetic would not.
 */
export function requiredTokens(
  estimatedPromptTokens: number,
  maxReplyTokens: number,
  marginRatio: number = DEFAULT_MARGIN_RATIO
): number {
  const exact = (estimatedPromptTokens + maxReplyTokens) * (1 + marginRatio)
  return Math.ceil(Number(exact.toPrecision(12)))
}

/** Refuse, don't truncate: throws when the reservation exceeds the context. */
export function assertFits(
  estimatedPromptTokens: number,
  maxReplyTokens: number,
  contextTokens: number,
  marginRatio: number = DEFAULT_MARGIN_RATIO
): void {
  const required = requiredTokens(
    estimatedPromptTokens,
    maxReplyTokens,
    marginRatio
  )
  if (required > contextTokens) {
    throw new PromptTooLargeError(
      estimatedPromptTokens,
      required,
      contextTokens
    )
  }
}

/** The server counted far fewer prompt tokens than estimated: it likely cut the prompt. */
export function truncationSuspected(
  estimatedPromptTokens: number,
  reportedPromptTokens: number,
  tripwireRatio: number,
  tripwireMinPromptTokens: number
): boolean {
  return (
    estimatedPromptTokens > tripwireMinPromptTokens &&
    reportedPromptTokens < tripwireRatio * estimatedPromptTokens
  )
}
