import { SIMPLEFIN_CONNECTOR, SIMPLEFIN_HOST } from "./config"

export interface SimpleFinTransaction {
  id: string
  posted: number
  amount: string
  description: string
  pending?: boolean
  transacted_at?: number
  extra?: Record<string, unknown>
}

export interface SimpleFinAccount {
  id: string
  name: string
  currency: string
  balance: string
  "balance-date": number
  "available-balance"?: string
  transactions?: SimpleFinTransaction[]
}

export interface SimpleFinResponse {
  accounts: SimpleFinAccount[]
  errors?: string[]
  errlist?: string[]
}

export interface GetAccountsParams {
  startDate?: number
  endDate?: number
  balancesOnly?: boolean
  account?: string
}

export interface SimpleFinClientOptions {
  /** If set, requests are routed through the gate's credential-injecting egress proxy. */
  proxyUrl?: string
  /** If set, direct base URL used (for testing with local stub bridge). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * Scrubs URLs from error strings so secrets or URLs in errors are never logged or leaked.
 */
export function scrubUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
}

export class SimpleFinError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(scrubUrls(message))
    this.name = "SimpleFinError"
  }
}

export interface SimpleFinClient {
  getAccounts(params?: GetAccountsParams): Promise<{
    accounts: SimpleFinAccount[]
    errors: string[]
  }>
}

export function createSimpleFinClient(
  options: SimpleFinClientOptions = {}
): SimpleFinClient {
  const fetchFn = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000

  return {
    async getAccounts(params: GetAccountsParams = {}) {
      const searchParams = new URLSearchParams()
      if (params.startDate !== undefined) {
        searchParams.set("start-date", String(params.startDate))
      }
      if (params.endDate !== undefined) {
        searchParams.set("end-date", String(params.endDate))
      }
      if (params.balancesOnly) {
        searchParams.set("balances-only", "1")
      }
      if (params.account !== undefined) {
        searchParams.set("account", params.account)
      }

      const queryString = searchParams.toString()
      const queryPart = queryString ? `?${queryString}` : ""

      let requestUrl: string
      const headers = new Headers()

      if (options.proxyUrl) {
        requestUrl = options.proxyUrl
        const targetUrl = `https://${SIMPLEFIN_HOST}/simplefin/accounts${queryPart}`
        headers.set("x-eido-connector", SIMPLEFIN_CONNECTOR)
        headers.set("x-eido-target", targetUrl)
      } else {
        const base = options.baseUrl ?? `https://${SIMPLEFIN_HOST}/simplefin`
        const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base
        requestUrl = `${normalizedBase}/accounts${queryPart}`
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let response: Response
      try {
        response = await fetchFn(requestUrl, {
          method: "GET",
          headers,
          signal: controller.signal,
        })
      } catch (err) {
        clearTimeout(timer)
        if (err instanceof SimpleFinError) throw err
        const rawMessage = err instanceof Error ? err.message : String(err)
        throw new SimpleFinError(500, "network_error", scrubUrls(rawMessage))
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        throw new SimpleFinError(
          response.status,
          response.status === 401 || response.status === 403
            ? "unauthorized"
            : response.status === 429
              ? "rate_limited"
              : "request_failed",
          `SimpleFIN request failed with status ${response.status}`
        )
      }

      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new SimpleFinError(
          502,
          "invalid_json",
          "SimpleFIN returned invalid JSON"
        )
      }

      if (typeof data !== "object" || data === null || !("accounts" in data)) {
        throw new SimpleFinError(
          502,
          "invalid_payload",
          "SimpleFIN payload missing accounts array"
        )
      }

      const payload = data as SimpleFinResponse
      const rawErrors = [
        ...(Array.isArray(payload.errors) ? payload.errors : []),
        ...(Array.isArray(payload.errlist) ? payload.errlist : []),
      ]

      const errors = rawErrors.map((e) => scrubUrls(String(e)))
      const accounts = Array.isArray(payload.accounts) ? payload.accounts : []

      return { accounts, errors }
    },
  }
}
