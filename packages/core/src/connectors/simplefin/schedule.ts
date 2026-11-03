import { SIMPLEFIN_SYNC_INTERVAL_MS } from "./config"
import type { SyncTime } from "./config"

// When SimpleFIN syncs (#546). With a configured local time, one sync a day at that time on the
// host's calendar; without one, one every SIMPLEFIN_SYNC_INTERVAL_MS. All of it is pure over
// the clock it is given, in the host's time zone (the same zone the gate counts its daily budget in).

function localOccurrence(
  nowMs: number,
  time: SyncTime,
  dayOffset: number
): number {
  const day = new Date(nowMs)
  day.setDate(day.getDate() + dayOffset)
  day.setHours(time.hour, time.minute, 0, 0)
  return day.getTime()
}

/** The latest scheduled local time at or before `nowMs`. */
export function lastScheduledAt(nowMs: number, time: SyncTime): number {
  const today = localOccurrence(nowMs, time, 0)
  return today <= nowMs ? today : localOccurrence(nowMs, time, -1)
}

/** The first scheduled local time after `nowMs`. */
export function nextScheduledAt(nowMs: number, time: SyncTime): number {
  const today = localOccurrence(nowMs, time, 0)
  return today > nowMs ? today : localOccurrence(nowMs, time, 1)
}

/** The next local midnight after `nowMs`, when the daily request budget starts over. */
export function nextLocalMidnight(nowMs: number): number {
  return nextScheduledAt(nowMs, { hour: 0, minute: 0 })
}

/**
 * Whether a scheduled sync is due. `lastStoredMs` is when a sync last stored a window (a sync on
 * request counts), or undefined when none has. With a time: due once its latest occurrence has
 * passed with no sync since. Without: due once the interval has passed.
 */
export function syncDue(
  nowMs: number,
  lastStoredMs: number | undefined,
  time: SyncTime | undefined
): boolean {
  if (lastStoredMs === undefined) return true
  return time === undefined
    ? nowMs - lastStoredMs >= SIMPLEFIN_SYNC_INTERVAL_MS
    : lastStoredMs < lastScheduledAt(nowMs, time)
}

/** When the next scheduled sync starts, or `nowMs` when one is due already. */
export function nextSyncAtMs(
  nowMs: number,
  lastStoredMs: number | undefined,
  time: SyncTime | undefined
): number {
  if (syncDue(nowMs, lastStoredMs, time)) return nowMs
  return time === undefined
    ? (lastStoredMs ?? nowMs) + SIMPLEFIN_SYNC_INTERVAL_MS
    : nextScheduledAt(nowMs, time)
}
