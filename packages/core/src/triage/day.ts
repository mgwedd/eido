import { addDays, localParts } from "../brief/local-time"

const MINUTE_MS = 60_000

/**
 * The first instant (to the minute) at which the local date in `timezone` is `date` or later.
 * The local date never decreases as time advances, so a bisection finds it, and it stays right on
 * a day that has 23 or 25 hours.
 */
function firstInstantOf(date: string, timezone: string): number {
  const [year, month, day] = date.split("-").map(Number)
  const guess = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)
  // A zone's offset is within +-14 h, so the instant lies within 15 h of the UTC midnight.
  let low = Math.floor((guess - 15 * 60 * MINUTE_MS) / MINUTE_MS)
  let high = Math.ceil((guess + 15 * 60 * MINUTE_MS) / MINUTE_MS)
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (localParts(new Date(middle * MINUTE_MS), timezone).date >= date)
      high = middle
    else low = middle + 1
  }
  return low * MINUTE_MS
}

/** The local calendar day containing `now`: its date and its [start, end) instants as ISO strings. */
export function localDay(
  now: Date,
  timezone: string
): { date: string; start: string; end: string } {
  const { date } = localParts(now, timezone)
  return {
    date,
    start: new Date(firstInstantOf(date, timezone)).toISOString(),
    end: new Date(firstInstantOf(addDays(date, 1), timezone)).toISOString(),
  }
}
