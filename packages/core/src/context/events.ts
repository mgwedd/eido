import type { DatabaseSync } from "node:sqlite"
import { APPLE_CALENDAR_CONNECTOR } from "../connectors/apple-calendar/sync"
import { fence, normalizeMaterial, toMaterial } from "../inference/fence"
import type { PromptPart } from "../inference/fence"

// The Events block of a proposal pack: the indexed calendar events that share a word with the
// owner's request, with their uids, so the model can name an existing event (#746). Titles come
// from the calendar, so they are untrusted: the block is fenced like any other material.

/** At most this many events are shown. */
export const MAX_EVENT_LINES = 10
/** A title is cut at this many characters. */
export const MAX_EVENT_TITLE_CHARS = 80
/** The longest uid a calendar intent carries (`eventUid`). */
const MAX_EVENT_UID_CHARS = 256

export interface EventLine {
  uid: string
  title: string
  start: string
  end: string
  allDay: boolean
  source: string
}

export interface MatchingEvents {
  /** The shown events: best match first, soonest first on ties. At most `MAX_EVENT_LINES`. */
  events: EventLine[]
  /** How many events shared a word with the request, shown or not. */
  matched: number
}

// Words that carry no match: articles and prepositions, plus the words every request about a
// calendar event holds.
const STOP_WORDS = new Set(
  (
    "a an and are as at be but by for from has have i if in into is it its me my of on or our so " +
    "that the their then there these this those to up us was we were what when which who will with " +
    "you your please can could would should do does did not no yes all any some " +
    "calendar calendars event events meeting meetings appointment appointments invite invites " +
    "invitation invitations today tomorrow " +
    "cancel cancelled canceled cancelling delete deleted remove removed move moved reschedule " +
    "rescheduled postpone postponed update updated rename renamed edit edited change changed " +
    "add create new set put"
  ).split(" ")
)

function words(text: string): Set<string> {
  const found = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(found.filter((w) => !STOP_WORDS.has(w)))
}

const LIVE_EVENTS = `SELECT f.event_id, f.source, f.start_at, f.end_at, f.all_day, t.title
  FROM document_heads h
  JOIN calendar_event_facts f ON f.sha256 = h.sha256
  JOIN document_text t ON t.sha256 = h.sha256
  WHERE h.source = f.source`

/**
 * The current calendar events of the document index whose title shares a word with the request
 * (lowercase, stop words removed), best match first, soonest first on ties, at most ten, titles
 * cut at 80 characters. A request that shares no word gets none, and an event whose uid would not
 * reach the model unchanged, or could not be named by an intent, is never listed.
 */
export function listMatchingEvents(
  db: DatabaseSync,
  request: string
): MatchingEvents {
  const wanted = words(request)
  const scored = db
    .prepare(LIVE_EVENTS)
    .all()
    .flatMap((row) => {
      const uid = String(row["event_id"])
      if (normalizeMaterial(uid) !== uid || uid.length > MAX_EVENT_UID_CHARS)
        return []
      const title = typeof row["title"] === "string" ? row["title"] : ""
      const shared = [...words(title)].filter((w) => wanted.has(w)).length
      if (shared === 0) return []
      return [
        {
          score: shared,
          line: {
            uid,
            title: title
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, MAX_EVENT_TITLE_CHARS),
            start: String(row["start_at"]),
            end: String(row["end_at"]),
            allDay: row["all_day"] === 1,
            source: String(row["source"]),
          },
        },
      ]
    })
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Date.parse(a.line.start) - Date.parse(b.line.start) ||
      (a.line.uid < b.line.uid ? -1 : 1)
  )
  return {
    events: scored.slice(0, MAX_EVENT_LINES).map((s) => s.line),
    matched: scored.length,
  }
}

/**
 * The Events block as prompt parts: a header, then one line per event, inside the pack's data
 * fence. An Apple Calendar event is marked read-only: `calendar.edit` and `calendar.delete` are
 * Proton invitation operations and refuse its uid. No events render nothing.
 */
export function renderEventsBlock(list: MatchingEvents): PromptPart[] {
  if (list.events.length === 0) return []
  const lines = list.events.map(
    (e) =>
      `- uid=${e.uid} | ${e.title} | ${e.start} to ${e.end}${e.allDay ? " | all-day" : ""} | source=${e.source}${e.source === APPLE_CALENDAR_CONNECTOR ? " | read-only" : ""}`
  )
  const header = `## Events (${String(list.events.length)} of ${String(list.matched)} match)`
  return [
    "\n\nEvents you may refer to:\n",
    fence(toMaterial([header, ...lines].join("\n"), { source: "document" })),
  ]
}
