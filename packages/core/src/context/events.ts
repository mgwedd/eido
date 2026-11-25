import type { DatabaseSync } from "node:sqlite"
import { APPLE_CALENDAR_CONNECTOR } from "../connectors/apple-calendar/sync"
import { fence, normalizeMaterial, toMaterial } from "../inference/fence"
import type { PromptPart } from "../inference/fence"
import { matchWords, stopWords } from "./match-words"

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
  /**
   * The shown events, upcoming or past (see `listMatchingEvents`): best match first, nearest to now
   * first on ties. At most `MAX_EVENT_LINES`.
   */
  events: EventLine[]
  /** How many events of the shown kind (upcoming or past) shared a word with the request. */
  matched: number
  /**
   * The two best matches are equally good: they share as many words with the request and cover
   * as large a share of their own title. The request does not say which one it means.
   */
  ambiguous: boolean
}

// The words of a request about a calendar event that every such request holds.
const STOP_WORDS = stopWords(
  "calendar calendars event events meeting meetings appointment appointments invite invites " +
    "invitation invitations today tomorrow " +
    "cancel cancelled canceled cancelling delete deleted remove removed move moved reschedule " +
    "rescheduled postpone postponed update updated rename renamed edit edited change changed " +
    "add create new set put"
)

// Words that make a request clearly about events already over.
const PAST_WORDS = new Set(
  "yesterday ago last past earlier previous previously".split(" ")
)

function words(text: string): Set<string> {
  return matchWords(text, STOP_WORDS)
}

/** Whether the request is about events already over ("yesterday", "last week", "two days ago"). */
function aboutThePast(request: string): boolean {
  const found = request.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return found.some((w) => PAST_WORDS.has(w))
}

// Live event heads whose uid an intent can carry. Matching titles against the request stays in
// JavaScript: SQLite's lower() and LIKE fold ASCII only, so a word filter in SQL would miss
// titles in other scripts.
const LIVE_EVENTS = `SELECT f.event_id, f.source, f.start_at, f.end_at, f.all_day, t.title
  FROM document_heads h
  JOIN calendar_event_facts f ON f.sha256 = h.sha256 AND f.source = h.source
  JOIN document_text t ON t.sha256 = h.sha256
  WHERE length(f.event_id) <= ${String(MAX_EVENT_UID_CHARS)}`

interface Scored {
  score: number
  coverage: number
  /** Start, as milliseconds. */
  start: number
  upcoming: boolean
  line: EventLine
}

/**
 * The current calendar events of the document index whose title shares a word with the request
 * (lowercase, stop words removed), at most ten, titles cut at 80 characters. Upcoming events (not
 * yet ended at `now`) are listed, soonest first on ties; past events instead, most recent first,
 * only when the request is about the past or no upcoming event matches. Best match first: most
 * shared words, then the largest share of the title covered. A request that shares no word gets
 * none, and an event whose uid would not reach the model unchanged is never listed.
 */
export function listMatchingEvents(
  db: DatabaseSync,
  request: string,
  now: Date
): MatchingEvents {
  const wanted = words(request)
  const scored = db
    .prepare(LIVE_EVENTS)
    .all()
    .flatMap((row): Scored[] => {
      const uid = String(row["event_id"])
      if (normalizeMaterial(uid) !== uid) return []
      const title = typeof row["title"] === "string" ? row["title"] : ""
      const titleWords = words(title)
      const shared = [...titleWords].filter((w) => wanted.has(w)).length
      if (shared === 0) return []
      const start = String(row["start_at"])
      const end = String(row["end_at"])
      return [
        {
          score: shared,
          coverage: shared / titleWords.size,
          start: Date.parse(start),
          upcoming: Date.parse(end) >= now.getTime(),
          line: {
            uid,
            title: title
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, MAX_EVENT_TITLE_CHARS),
            start,
            end,
            allDay: row["all_day"] === 1,
            source: String(row["source"]),
          },
        },
      ]
    })
  const upcoming = scored.filter((s) => s.upcoming)
  const past = scored.filter((s) => !s.upcoming)
  const preferPast =
    past.length > 0 && (upcoming.length === 0 || aboutThePast(request))
  const shown = preferPast ? past : upcoming
  // Nearest to now first: soonest upcoming, or most recent past.
  const direction = preferPast ? -1 : 1
  shown.sort(
    (a, b) =>
      b.score - a.score ||
      b.coverage - a.coverage ||
      direction * (a.start - b.start) ||
      (a.line.uid < b.line.uid ? -1 : 1)
  )
  const [first, second] = shown
  return {
    events: shown.slice(0, MAX_EVENT_LINES).map((s) => s.line),
    matched: shown.length,
    ambiguous:
      first !== undefined &&
      second !== undefined &&
      first.score === second.score &&
      first.coverage === second.coverage,
  }
}

/**
 * The Events block as prompt parts: a header, then one line per event, inside the pack's data
 * fence. An Apple Calendar event is marked read-only: `calendar.edit` and `calendar.delete` are
 * Proton invitation operations and refuse its uid. No events render nothing.
 */
export function renderEventsBlock(
  list: Pick<MatchingEvents, "events" | "matched">
): PromptPart[] {
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
