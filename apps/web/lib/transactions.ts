import {
  validateCoreApiTransactionList,
  type CoreApiTransactionList,
} from "@eido/schemas"

export type TransactionItem = CoreApiTransactionList["transactions"][number]
export type TransactionAccount = CoreApiTransactionList["accounts"][number]

export const TRANSACTIONS_URL = "/api/core/transactions"
export const TRANSACTIONS_PAGE_SIZE = 50

export interface LoadTransactionsOptions {
  entity?: string
  account?: string
  limit?: number
  offset?: number
}

export type TransactionsLoadResult =
  | { status: "ok"; data: CoreApiTransactionList }
  | { status: "unauthenticated" }
  | { status: "error"; message: string }

/** Loads stored bank transactions from core over HTTP. Read only. */
export async function loadTransactions(
  signal: AbortSignal,
  options: LoadTransactionsOptions = {}
): Promise<TransactionsLoadResult> {
  try {
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost"
    const url = new URL(TRANSACTIONS_URL, origin)
    if (options.entity && options.entity !== "all") {
      url.searchParams.set("entity", options.entity)
    }
    if (options.account && options.account !== "all") {
      url.searchParams.set("account", options.account)
    }
    if (typeof options.limit === "number") {
      url.searchParams.set("limit", String(options.limit))
    }
    if (typeof options.offset === "number" && options.offset > 0) {
      url.searchParams.set("offset", String(options.offset))
    }

    const response = await fetch(url.toString(), {
      cache: "no-store",
      signal,
    })
    if (response.status === 401) return { status: "unauthenticated" }
    if (!response.ok) {
      return { status: "error", message: `HTTP ${response.status}` }
    }

    const body: unknown = await response.json()
    const parsed = validateCoreApiTransactionList(body)
    if (!parsed.ok) {
      return {
        status: "error",
        message: `Invalid schema: ${parsed.errors.join("; ")}`,
      }
    }
    return { status: "ok", data: parsed.value }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error
    }
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Network error",
    }
  }
}

/** The page's own URL for a filter choice; the filters live in the query string. */
export function transactionsPageUrl(entity: string, account: string): string {
  const params = new URLSearchParams()
  if (entity && entity !== "all") params.set("entity", entity)
  if (account && account !== "all") params.set("account", account)
  const query = params.toString()
  return query ? `/ledger/transactions?${query}` : "/ledger/transactions"
}

/**
 * Where a transaction's linked obligation opens: the ledger's Obligations tab for the obligation's
 * entity, which core guarantees is the transaction's own.
 */
export function linkedObligationUrl(entityId: string): string {
  return `/ledger?${new URLSearchParams({ entity: entityId }).toString()}`
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/**
 * "Oct 17" for a stored posted time, read in UTC because the stored value is the bank's posted
 * day, which a local zone would shift. The year follows when it is not the current one.
 */
export function formatPostedDate(postedAt: string, now: Date): string {
  const date = new Date(postedAt)
  if (Number.isNaN(date.getTime())) return postedAt
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
  return date.getUTCFullYear() === now.getFullYear()
    ? day
    : `${day}, ${date.getUTCFullYear()}`
}

/**
 * A stored amount with its sign shown in text: "−$84.12" for money out, "+$2,000.00" for money
 * in. A currency code the runtime does not know is written after the number.
 */
export function formatAmount(amountCents: number, currency: string): string {
  const sign = amountCents < 0 ? "−" : amountCents > 0 ? "+" : ""
  const value = Math.abs(amountCents) / 100
  try {
    return `${sign}${new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)}`
  } catch {
    return `${sign}${value.toFixed(2)} ${currency}`
  }
}

/** The summary line, counted from the rows shown: "Oct 1 – Oct 17 · 6 transactions". */
export function summarizeTransactions(
  rows: readonly TransactionItem[],
  now: Date
): string {
  const count = `${rows.length} ${rows.length === 1 ? "transaction" : "transactions"}`
  const times = rows
    .map((row) => new Date(row.postedAt).getTime())
    .filter((time) => !Number.isNaN(time))
  if (times.length === 0) return count
  const first = formatPostedDate(
    new Date(Math.min(...times)).toISOString(),
    now
  )
  const last = formatPostedDate(new Date(Math.max(...times)).toISOString(), now)
  return first === last
    ? `${first} · ${count}`
    : `${first} – ${last} · ${count}`
}
