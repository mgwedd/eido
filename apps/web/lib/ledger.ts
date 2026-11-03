import {
  validateCoreApiObligationList,
  type CoreApiObligationList,
} from "@eido/schemas"

export type ObligationItem = CoreApiObligationList["obligations"][number]
export type ObligationStatus = "open" | "done" | "dismissed"
export type ObligationStatusFilter = "all" | ObligationStatus

export const OBLIGATIONS_URL = "/api/core/obligations"
export const DEFAULT_LEDGER_LIMIT = 50

export interface LoadLedgerOptions {
  id?: number
  entity?: string
  status?: ObligationStatusFilter
  direction?: "owed" | "waiting"
  limit?: number
  offset?: number
}

export type LedgerLoadResult =
  | { status: "ok"; data: CoreApiObligationList }
  | { status: "unauthenticated" }
  | { status: "error"; message: string }

/**
 * Loads obligations from core over HTTP.
 */
export async function loadLedgerObligations(
  signal: AbortSignal,
  options: LoadLedgerOptions = {}
): Promise<LedgerLoadResult> {
  try {
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost"
    const url = new URL(OBLIGATIONS_URL, origin)
    if (typeof options.id === "number") {
      url.searchParams.set("id", String(options.id))
    }
    if (options.entity && options.entity !== "all") {
      url.searchParams.set("entity", options.entity)
    }
    if (options.status && options.status !== "all") {
      url.searchParams.set("status", options.status)
    }
    if (options.direction) {
      url.searchParams.set("direction", options.direction)
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

    if (response.status === 401) {
      return { status: "unauthenticated" }
    }
    if (!response.ok) {
      return {
        status: "error",
        message: `HTTP ${response.status}`,
      }
    }

    const body: unknown = await response.json()
    const parsed = validateCoreApiObligationList(body)
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

/**
 * Reads the `obligation` address parameter: `undefined` when absent, `null` when it is not a
 * positive integer id (no obligation can match it), else the id.
 */
export function parseObligationParam(
  raw: string | undefined
): number | null | undefined {
  if (raw === undefined) return undefined
  if (!/^[1-9][0-9]*$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : null
}
