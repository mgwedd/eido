import { PromptTooLargeError } from "./errors"

export const DEFAULT_CHARS_PER_TOKEN = 3
export const DEFAULT_MARGIN_RATIO = 0.1

const ASCII_ONLY = /^[\x00-\x7f]*$/
const LATIN_ESTIMATE_CHARACTER =
  /^[\u0000-\u02af\u0300-\u036f\u1e00-\u1eff\u2000-\u206f\u20a0-\u20cf]$/u

/**
 * A conservative token estimate: Latin-script and common punctuation code points count as one
 * character; code points from other scripts count as `charsPerToken` characters. The latter
 * makes scripts such as Japanese, where a code point is often a token, safe against undercounting.
 */
export function estimateTokens(
  text: string,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN
): number {
  if (ASCII_ONLY.test(text)) {
    return Math.ceil(text.length / charsPerToken)
  }

  let weightedCharacters = 0
  // Iterating a string yields code points, so an astral character counts once.
  for (const character of text) {
    weightedCharacters += LATIN_ESTIMATE_CHARACTER.test(character)
      ? 1
      : charsPerToken
  }
  return Math.ceil(weightedCharacters / charsPerToken)
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
