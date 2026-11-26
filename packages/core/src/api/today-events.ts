import type { DatabaseSync } from "node:sqlite"
import type { CoreApiTodayEvents } from "@eido/schemas"
import { APPLE_CALENDAR_CONNECTOR } from "../connectors/apple-calendar/sync"
import { localDay } from "../triage/day"

/** GET /today/events (#833): the day's Apple Calendar events. */
export const TODAY_EVENTS_PATH = "/today/events"

/** A day lists at most this many events (the schema's `maxItems`). */
export const MAX_TODAY_EVENTS = 200
/** A title is cut at this many characters (the schema's `maxLength`). */
export const MAX_TODAY_EVENT_TITLE_CHARS = 200

// Live event heads only: syncing a calendar that was retired, excluded or disabled removes its
// heads (`retireCalendar`), so its events are not here. Past versions of an edited event have no
// head either. The event's day test runs in JavaScript: stored instants may carry an offset, so
// they do not compare as text.
const LIVE_APPLE_EVENTS = `SELECT f.event_id, f.start_at, f.end_at, f.all_day, t.title
  FROM document_heads h
  JOIN calendar_event_facts f ON f.sha256 = h.sha256 AND f.source = h.source
  JOIN document_text t ON t.sha256 = h.sha256
  WHERE f.source = ?`

interface Row {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  startMs: number
  endMs: number
}

function readRow(row: Record<string, unknown>): Row | null {
  const start = String(row["start_at"])
  const end = String(row["end_at"])
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
  return {
    id: String(row["event_id"]),
    title: String(row["title"] ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TODAY_EVENT_TITLE_CHARS),
    start,
    end,
    allDay: row["all_day"] === 1,
    startMs,
    endMs,
  }
}

/**
 * The current Apple Calendar events that overlap the local day containing `now` in `timezone`,
 * earliest start first (all-day events share the day's first instant, so ties go by uid). An
 * event overlaps when it starts before the day ends and ends after the day starts; an event with
 * no length counts when it starts within the day. Titles are cut at 200 characters and at most
 * 200 events are listed.
 */
export function todayEventsRoute(
  db: DatabaseSync,
  timezone: string,
  now: Date
): CoreApiTodayEvents {
  const day = localDay(now, timezone)
  const dayStart = Date.parse(day.start)
  const dayEnd = Date.parse(day.end)
  const events = db
    .prepare(LIVE_APPLE_EVENTS)
    .all(APPLE_CALENDAR_CONNECTOR)
    .flatMap((row): Row[] => {
      const event = readRow(row)
      if (event === null) return []
      const overlaps =
        event.startMs < dayEnd &&
        (event.endMs > dayStart || event.startMs >= dayStart)
      return overlaps ? [event] : []
    })
    .sort(
      (a, b) =>
        a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    .slice(0, MAX_TODAY_EVENTS)
    .map(({ id, title, start, end, allDay }) => ({
      id,
      title,
      start,
      end,
      allDay,
    }))
  return { timezone, date: day.date, events }
}
