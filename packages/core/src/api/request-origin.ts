const STATE_CHANGING = new Set(["POST", "PATCH", "PUT", "DELETE"])

export interface RequestOriginInput {
  method: string
  /** The `Sec-Fetch-Site` header, or null when absent. */
  secFetchSite: string | null
  /** The `Origin` header, or null when absent. */
  origin: string | null
  /** The request's Host header, lowercased. */
  host: string
  /** The configured allowed Host values, lowercased. */
  allowedHosts: ReadonlySet<string>
}

/**
 * Whether a state-changing request may proceed. A browser marks every request with
 * `Sec-Fetch-Site` and, for non-GET, `Origin`; a request from another site is refused. A request
 * with neither header (the gate, scripts, server-side callers) passes: the check stops a page in
 * the owner's browser, not other clients.
 */
export function crossSiteRefused(input: RequestOriginInput): boolean {
  if (!STATE_CHANGING.has(input.method.toUpperCase())) return false
  if (input.secFetchSite?.toLowerCase() === "cross-site") return true
  if (input.origin === null) return false
  let originHost: string
  try {
    originHost = new URL(input.origin).host.toLowerCase()
  } catch {
    return true
  }
  return originHost !== input.host && !input.allowedHosts.has(originHost)
}
