/** Which Apple calendars core reads: every calendar the Helper lists, or the named ones. */
export type AppleCalendarSelection =
  { kind: "all" } | { kind: "ids"; ids: readonly string[] }

/** The longest calendar id the gate's EventKit API accepts. */
const MAX_CALENDAR_ID_LENGTH = 1024

/**
 * Parse `EIDO_APPLE_CALENDARS`. Unset or empty: Apple calendar sync is off. `*`: every calendar
 * the Helper lists. Otherwise a comma-separated list of EventKit calendar ids.
 */
export function parseAppleCalendarSelection(
  value: string | undefined
): AppleCalendarSelection | undefined {
  if (value === undefined || value.trim() === "") return undefined
  if (value.trim() === "*") return { kind: "all" }
  const ids = value.split(",").map((id) => id.trim())
  if (ids.some((id) => id === "" || id.length > MAX_CALENDAR_ID_LENGTH))
    throw new Error(
      "EIDO_APPLE_CALENDARS must be * or a comma-separated list of calendar ids"
    )
  return { kind: "ids", ids: [...new Set(ids)] }
}
