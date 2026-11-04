import {
  validateCoreApiSimpleFinSync,
  validateGateConnectorHealth,
  type CoreApiSimpleFinSync,
} from "@eido/schemas"

export const SIMPLEFIN_SYNC_URL = "/api/core/connectors/simplefin/sync"
export const CONNECTOR_HEALTH_URL = "/api/core/connectors/health"

/** What the simplefin row of core's connector health says about the sync budget. */
export type SimpleFinSyncHealth = {
  nextSyncAt?: string
  requestsToday?: number
  requestLimit?: number
  /** The connector's own failure summary, shown under a failed sync. */
  lastError?: string
}

/** The row's read: "offline" carries no data; "error" leaves the button usable without counts. */
export type SimpleFinHealthLoad =
  | { status: "ready"; health: SimpleFinSyncHealth }
  | { status: "offline" }
  | { status: "error" }

export async function loadSimpleFinHealth(
  signal: AbortSignal
): Promise<SimpleFinHealthLoad> {
  try {
    const response = await fetch(CONNECTOR_HEALTH_URL, {
      cache: "no-store",
      signal,
    })
    if (!response.ok) return { status: "error" }
    const parsed = validateGateConnectorHealth(await response.json())
    if (!parsed.ok) return { status: "error" }
    const row = parsed.value.connectors.find((c) => c.name === "simplefin")
    if (row === undefined) return { status: "error" }
    return {
      status: "ready",
      health: {
        ...(row.nextSyncAt === undefined ? {} : { nextSyncAt: row.nextSyncAt }),
        ...(row.requestsToday === undefined
          ? {}
          : { requestsToday: row.requestsToday }),
        ...(row.requestLimit === undefined
          ? {}
          : { requestLimit: row.requestLimit }),
        ...(row.lastError === undefined ? {} : { lastError: row.lastError }),
      },
    }
  } catch (error) {
    if (!signal.aborted && error instanceof TypeError)
      return { status: "offline" }
    return { status: "error" }
  }
}

export type SimpleFinSyncOutcome =
  | { status: "synced"; nextSyncAt?: string }
  | {
      status: "refused"
      reason: NonNullable<CoreApiSimpleFinSync["reason"]>
      nextSyncAt?: string
    }
  | { status: "failed" }

/** Starts one sync. 200 must say synced and 409 must say refused with a reason; anything else failed. */
export async function runSimpleFinSync(): Promise<SimpleFinSyncOutcome> {
  try {
    const response = await fetch(SIMPLEFIN_SYNC_URL, {
      method: "POST",
      cache: "no-store",
    })
    if (response.status !== 200 && response.status !== 409)
      return { status: "failed" }
    const parsed = validateCoreApiSimpleFinSync(await response.json())
    if (!parsed.ok) return { status: "failed" }
    const body = parsed.value
    const nextSyncAt =
      body.nextSyncAt === undefined ? {} : { nextSyncAt: body.nextSyncAt }
    if (response.status === 200 && body.status === "synced")
      return { status: "synced", ...nextSyncAt }
    if (
      response.status === 409 &&
      body.status === "refused" &&
      body.reason !== undefined
    )
      return { status: "refused", reason: body.reason, ...nextSyncAt }
    return { status: "failed" }
  } catch {
    return { status: "failed" }
  }
}

/** "6:00 AM" in the viewer's locale and time zone. */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
    new Date(iso)
  )
}

/** True when today's request budget is spent. */
export function budgetSpent(health: SimpleFinSyncHealth): boolean {
  return (
    health.requestsToday !== undefined &&
    health.requestLimit !== undefined &&
    health.requestsToday >= health.requestLimit
  )
}

/**
 * "Next sync 6:00 AM · 3 of 24 requests today". Once the budget is spent there is no next sync
 * until midnight, so the line is just the count. Empty when health sent neither part.
 */
export function syncLine(health: SimpleFinSyncHealth): string {
  const next =
    health.nextSyncAt === undefined || budgetSpent(health)
      ? null
      : `Next sync ${formatTime(health.nextSyncAt)}`
  const count =
    health.requestsToday === undefined || health.requestLimit === undefined
      ? null
      : `${health.requestsToday} of ${health.requestLimit} requests today`
  return [next, count].filter((part) => part !== null).join(" · ")
}

export const SYNC_OFFLINE_LINE = "Offline. Sync needs a connection to the host."
export const SYNCING_MESSAGE = "Syncing SimpleFIN…"

export function syncedMessage(nextSyncAt: string | undefined): string {
  return nextSyncAt === undefined
    ? "Synced."
    : `Synced. Next sync ${formatTime(nextSyncAt)}.`
}

export function dailyLimitMessage(nextSyncAt: string | undefined): string {
  return nextSyncAt === undefined
    ? "Daily request limit reached."
    : `Daily request limit reached. Resets at ${formatTime(nextSyncAt)}.`
}

export const UNAVAILABLE_MESSAGE =
  "SimpleFIN is paused or failing in the gate. Nothing was synced."
export const SYNC_FAILED_MESSAGE = "Sync failed. Nothing was synced."
export const REQUEST_FAILED_MESSAGE =
  "Could not reach core. Nothing was synced."
