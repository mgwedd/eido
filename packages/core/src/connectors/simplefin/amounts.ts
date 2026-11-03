export type AmountParseResult =
  { ok: true; cents: number } | { ok: false; error: string }

/**
 * Parses a decimal currency string into integer cents without any floating-point arithmetic.
 * Examples:
 *   "-12.30" -> -1230
 *   "0.07"   -> 7
 *   "100"    -> 10000
 *   "100.5"  -> 10050
 *   "-0.05"  -> -5
 *
 * Any malformed format (e.g. "12.345", "abc", "", ".5", "12.") is rejected with an error.
 */
export function parseAmountCents(raw: unknown): AmountParseResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "amount must be a string" }
  }

  const trimmed = raw.trim()
  if (trimmed === "") {
    return { ok: false, error: "amount string cannot be empty" }
  }

  const match = /^([+-])?(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed)
  if (!match) {
    return { ok: false, error: `malformed amount string "${raw}"` }
  }

  const sign = match[1] === "-" ? -1n : 1n
  const integerStr = match[2] ?? "0"
  const fractionStr = (match[3] ?? "").padEnd(2, "0")

  const integerPart = BigInt(integerStr)
  const fractionPart = BigInt(fractionStr)

  const totalCentsBigInt = (integerPart * 100n + fractionPart) * sign

  if (
    totalCentsBigInt > BigInt(Number.MAX_SAFE_INTEGER) ||
    totalCentsBigInt < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return { ok: false, error: `amount exceeds safe integer range: "${raw}"` }
  }

  const cents = Number(totalCentsBigInt)
  // Ensure -0 becomes 0
  return { ok: true, cents: cents === 0 ? 0 : cents }
}
