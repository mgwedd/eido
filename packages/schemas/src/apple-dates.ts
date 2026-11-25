// Date rules for Apple event intents that one field's schema cannot state, because they
// depend on allDay. The gate refuses an intent that breaks them before approval, and the
// EventKit Helper applies the same rules (apps/helper/README.md).

const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:Z|[+-]\d{2}:\d{2})$/

/** The calendar date an all-day bound names: the date as written in a midnight
 * date-time, with its offset ignored. Undefined when the bound is not midnight. */
export function allDayDate(value: string): string | undefined {
  return MIDNIGHT.exec(value)?.[1]
}

/** Why an Apple event's start and end cannot be saved, or undefined when they can.
 * A timed event ends after it starts. An all-day event's bounds are midnights whose
 * dates run from the first day up to, but not including, end's date. */
export function appleEventDatesError(args: {
  start: string
  end: string
  allDay: boolean
}): string | undefined {
  if (!args.allDay) {
    return Date.parse(args.end) > Date.parse(args.start)
      ? undefined
      : "$.args.end: must be later than start"
  }
  const start = allDayDate(args.start)
  if (start === undefined)
    return "$.args.start: an all-day start must be midnight (T00:00:00)"
  const end = allDayDate(args.end)
  if (end === undefined)
    return "$.args.end: an all-day end must be midnight (T00:00:00)"
  return end > start
    ? undefined
    : "$.args.end: an all-day end date must be later than start's date"
}
