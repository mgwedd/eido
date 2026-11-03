import type { DatabaseSync } from "node:sqlite"
import { getPinnedManifest } from "./connectors"

/** The gate host's local calendar day of `now`, as YYYY-MM-DD. */
export function localDay(now: number): string {
  const date = new Date(now)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The next local midnight after `now`, when a spent daily budget is available again. */
export function nextLocalMidnight(now: number): number {
  const date = new Date(now)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1
  ).getTime()
}

/** A connector's daily request limit from its pinned manifest, if it sets one. */
export function dailyRequestLimit(
  db: DatabaseSync,
  connector: string
): number | undefined {
  return getPinnedManifest(db, connector)?.health?.rateLimit?.requestsPerDay
}

/**
 * Takes one request from the connector's daily budget. It returns false, and counts nothing, when
 * today's budget is spent. A connector without a limit is always admitted. The check and the count
 * are one statement, so concurrent reads never overspend.
 */
export function takeDailyRequest(
  db: DatabaseSync,
  connector: string,
  now: number
): boolean {
  const limit = dailyRequestLimit(db, connector)
  if (limit === undefined) return true
  const day = localDay(now)
  const result = db
    .prepare(
      `UPDATE connectors
       SET quota_requests = CASE WHEN quota_day = ? THEN quota_requests + 1 ELSE 1 END,
           quota_day = ?
       WHERE name = ? AND (quota_day IS NOT ? OR quota_requests < ?)`
    )
    .run(day, day, connector, day, limit)
  return Number(result.changes) === 1
}

/** Requests the proxy sent today for a connector, from the stored day and count. */
export function requestsToday(
  row: { quota_day: unknown; quota_requests: unknown },
  now: number
): number {
  return row.quota_day === localDay(now) ? Number(row.quota_requests) : 0
}
