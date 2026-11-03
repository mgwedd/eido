export type LocalParts = { date: string; minutes: number }

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Minutes after local midnight for an `HH:MM` time. */
export function parseTime(time: string): number {
  const match = TIME.exec(time)
  if (match === null) throw new RangeError("time must be HH:MM")
  return Number(match[1]) * 60 + Number(match[2])
}

/** The calendar date (YYYY-MM-DD) and minutes after midnight of `now` in an IANA timezone. */
export function localParts(now: Date, timezone: string): LocalParts {
  if (!Number.isFinite(now.getTime()))
    throw new RangeError("now must be a valid date")
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now)
  } catch {
    throw new RangeError("timezone must be a valid IANA timezone")
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? ""
  return {
    date: `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  }
}

const DAY_MS = 86_400_000

function dayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number)
  return Math.round(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / DAY_MS)
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from)
}

/** `date` moved by `days` calendar days. */
export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10)
}
