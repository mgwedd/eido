// Sender authentication from the Authentication-Results header (RFC 8601). Mail passes through
// many hosts and each can add its own header, so a sender can plant one that says everything
// passed. Only the topmost header, the one the receiving host added last, is read, and only when
// its authserv-id names a host we trust. Any other header is ignored.

export type AuthMethod = "spf" | "dkim" | "dmarc"
export type AuthResults = Partial<Record<AuthMethod, string>>

/**
 * Authserv-ids of the hosts whose verdicts core trusts, matched as a domain or any subdomain of it.
 * Not yet confirmed against a real Bridge (#197): a wrong id here means no verdict is trusted, so
 * no authentication signal is raised. It never trusts a verdict it should not.
 */
export const TRUSTED_AUTHSERV_IDS: readonly string[] = [
  "protonmail.ch",
  "proton.me",
]

/** Drops RFC 5322 comments, which may nest and may sit anywhere in the value. */
function stripComments(value: string): string {
  let depth = 0
  let quoted = false
  let out = ""
  for (const char of value) {
    if (char === '"' && depth === 0) quoted = !quoted
    if (!quoted && char === "(") depth++
    else if (!quoted && char === ")" && depth > 0) depth--
    else if (depth === 0) out += char
  }
  return out
}

function splitStatements(value: string): string[] {
  const parts: string[] = []
  let quoted = false
  let current = ""
  for (const char of value) {
    if (char === '"') quoted = !quoted
    if (char === ";" && !quoted) {
      parts.push(current)
      current = ""
    } else current += char
  }
  parts.push(current)
  return parts.map((p) => p.trim())
}

const RESULT = /^([a-z0-9-]+)\s*=\s*([a-z0-9-]+)/i

function isMethod(value: string): value is AuthMethod {
  return value === "spf" || value === "dkim" || value === "dmarc"
}

export function parseAuthenticationResults(value: string): {
  authservId: string
  results: AuthResults
} {
  const [head = "", ...statements] = splitStatements(stripComments(value))
  const results: AuthResults = {}
  for (const statement of statements) {
    const match = RESULT.exec(statement)
    const method = match?.[1]?.toLowerCase()
    const result = match?.[2]?.toLowerCase()
    if (method === undefined || result === undefined || !isMethod(method))
      continue
    // A message can carry several DKIM signatures; one that verifies is enough.
    if (method === "dkim" && results.dkim === "pass") continue
    results[method] = result
  }
  return {
    authservId: (head.split(/\s+/)[0] ?? "").toLowerCase(),
    results,
  }
}

/**
 * The verdicts of the trusted Authentication-Results header, or undefined when the topmost header
 * is missing or comes from a host that is not trusted. `headers` are in message order, top first.
 */
export function trustedAuthResults(
  headers: readonly string[],
  trustedAuthservIds: readonly string[] = TRUSTED_AUTHSERV_IDS
): AuthResults | undefined {
  const top = headers[0]
  if (top === undefined) return undefined
  const { authservId, results } = parseAuthenticationResults(top)
  const trusted = trustedAuthservIds.some(
    (t) => authservId === t || authservId.endsWith(`.${t}`)
  )
  return trusted ? results : undefined
}
