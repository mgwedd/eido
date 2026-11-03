import { SIMPLEFIN_CONNECTOR, SIMPLEFIN_HOST } from "./config"
import { SIMPLEFIN_ACCOUNTS_PATH } from "./manifest"

// The SimpleFIN read client. It talks only to the gate's egress proxy, which holds the access URL,
// injects it as a Basic header and enforces the daily request budget. Nothing here sees the
// credential, and response bodies are never logged.

export interface SimpleFinTransaction {
  id: string
  /** Unix seconds; 0 while pending. */
  posted: number
  amount: unknown
  description: string
  pending: boolean
  raw: Record<string, unknown>
}

export interface SimpleFinAccount {
  id: string
  name: string
  currency: string
  balance: unknown
  balanceDate: number | undefined
  transactions: SimpleFinTransaction[]
  /** Transaction records missing a field the ledger needs. */
  rejected: number
}

export interface SimpleFinAccounts {
  accounts: SimpleFinAccount[]
  /** SimpleFIN `errors` entries, scrubbed of URLs. */
  errors: string[]
}

export interface GetAccountsParams {
  /** Unix seconds, inclusive. */
  startDate?: number
  /** Unix seconds, exclusive. */
  endDate?: number
  balancesOnly?: boolean
}

export interface SimpleFinClientOptions {
  /** The gate's loopback egress proxy. */
  proxyUrl: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export type SimpleFinErrorCode =
  | "daily_limit"
  | "unauthorized"
  | "network_error"
  | "request_failed"
  | "invalid_payload"

const SCHEME_CHAR = /^[a-z0-9+.-]$/i
const LETTER = /^[a-z]$/i
const URL_REST = /[^\s"'<>]*/y

/**
 * Replaces every URL in `text` (a scheme of a letter then letters, digits, `+`, `.` or `-`, then
 * `://` and at least one character up to whitespace, a quote or `<>`), so an error string cannot
 * carry an access URL anywhere. It anchors on each `://` and scans outwards, so it runs in linear
 * time on any input, and a long run of letters before the scheme cannot hide a URL.
 */
export function scrubUrls(text: string): string {
  let out = ""
  let from = 0
  let at = text.indexOf("://")
  while (at !== -1) {
    let start = at
    while (start > from && SCHEME_CHAR.test(text.charAt(start - 1))) start--
    while (start < at && !LETTER.test(text.charAt(start))) start++
    URL_REST.lastIndex = at + 3
    URL_REST.exec(text)
    const end = URL_REST.lastIndex
    if (start < at && end > at + 3) {
      out += text.slice(from, start) + "[url]"
      from = end
    }
    at = text.indexOf("://", Math.max(at + 3, from))
  }
  return out + text.slice(from)
}

export class SimpleFinError extends Error {
  readonly code: SimpleFinErrorCode
  constructor(code: SimpleFinErrorCode, message: string) {
    super(scrubUrls(message))
    this.name = "SimpleFinError"
    this.code = code
  }
}

export interface SimpleFinClient {
  getAccounts(params?: GetAccountsParams): Promise<SimpleFinAccounts>
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): value is string => typeof value === "string"

function transactionOf(value: unknown): SimpleFinTransaction | undefined {
  if (!isRecord(value)) return undefined
  const { id, posted, amount, description, pending } = value
  if (!text(id) || id === "" || typeof posted !== "number") return undefined
  if (!Number.isSafeInteger(posted) || posted < 0) return undefined
  if (!text(description)) return undefined
  return {
    id,
    posted,
    amount,
    description,
    pending: pending === true,
    raw: value,
  }
}

function accountOf(value: unknown): SimpleFinAccount | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, currency, balance } = value
  if (!text(id) || id === "" || !text(name) || !text(currency)) return undefined
  const balanceDate = value["balance-date"]
  const transactions: SimpleFinTransaction[] = []
  let rejected = 0
  const listed = value["transactions"]
  for (const entry of Array.isArray(listed) ? listed : []) {
    const transaction = transactionOf(entry)
    if (transaction === undefined) rejected++
    else transactions.push(transaction)
  }
  return {
    id,
    name,
    currency,
    balance,
    balanceDate:
      typeof balanceDate === "number" && Number.isSafeInteger(balanceDate)
        ? balanceDate
        : undefined,
    transactions,
    rejected,
  }
}

/** Parses a SimpleFIN Account Set. A record the ledger cannot use is refused, not guessed. */
export function parseAccountSet(data: unknown): SimpleFinAccounts {
  if (!isRecord(data) || !Array.isArray(data["accounts"])) {
    throw new SimpleFinError(
      "invalid_payload",
      "SimpleFIN answered without an accounts list"
    )
  }
  const accounts: SimpleFinAccount[] = []
  for (const entry of data["accounts"]) {
    const account = accountOf(entry)
    if (account === undefined) {
      throw new SimpleFinError(
        "invalid_payload",
        "SimpleFIN answered with an account missing its id, name or currency"
      )
    }
    accounts.push(account)
  }
  const errors = data["errors"]
  return {
    accounts,
    errors: (Array.isArray(errors) ? errors : [])
      .filter(text)
      .map((entry) => scrubUrls(entry)),
  }
}

/** Gate refusals that only reconnecting the credential clears. */
const CREDENTIAL_REFUSALS: ReadonlySet<string> = new Set([
  "grant_revoked",
  "connector_disabled",
  "credential_missing",
  "credential_invalid",
])

async function reasonOf(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json()
    return isRecord(body) && text(body["reason"]) ? body["reason"] : undefined
  } catch {
    return undefined
  }
}

export function createSimpleFinClient(
  options: SimpleFinClientOptions
): SimpleFinClient {
  const send = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const endpoint = new URL("/", options.proxyUrl).href
  return {
    async getAccounts(params: GetAccountsParams = {}) {
      const target = new URL(
        `https://${SIMPLEFIN_HOST}${SIMPLEFIN_ACCOUNTS_PATH}`
      )
      if (params.startDate !== undefined)
        target.searchParams.set("start-date", String(params.startDate))
      if (params.endDate !== undefined)
        target.searchParams.set("end-date", String(params.endDate))
      if (params.balancesOnly === true)
        target.searchParams.set("balances-only", "1")
      let response: Response
      try {
        response = await send(endpoint, {
          method: "GET",
          headers: {
            "x-eido-connector": SIMPLEFIN_CONNECTOR,
            "x-eido-target": target.toString(),
          },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        throw new SimpleFinError(
          "network_error",
          "the gate egress proxy could not be reached"
        )
      }
      if (!response.ok) {
        const reason = await reasonOf(response)
        if (response.status === 429 && reason === "daily_limit") {
          throw new SimpleFinError(
            "daily_limit",
            "the daily SimpleFIN request limit is spent"
          )
        }
        if (reason !== undefined && CREDENTIAL_REFUSALS.has(reason)) {
          throw new SimpleFinError(
            "unauthorized",
            `the SimpleFIN credential is not usable (${reason}); reconnect it`
          )
        }
        throw new SimpleFinError(
          "request_failed",
          `SimpleFIN read failed with status ${String(response.status)}${reason === undefined ? "" : ` (${reason})`}`
        )
      }
      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new SimpleFinError(
          "invalid_payload",
          "SimpleFIN answered with invalid JSON"
        )
      }
      return parseAccountSet(data)
    },
  }
}
