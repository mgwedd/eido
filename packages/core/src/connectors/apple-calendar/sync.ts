import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { AppleClient } from "@eido/gate"
import type { GateAppleEventList } from "@eido/schemas"
import { writeQueueFor } from "../../db/write-queue"
import { ingestBatch } from "../../index/index"
import type { DocumentHeadChange, IndexedDocument } from "../../index/index"
import type { IngestEntities } from "../ingest-entity"
import type { AppleCalendarSelection } from "./config"

/** The gate connector, its health name and the indexed documents' source. */
export const APPLE_CALENDAR_CONNECTOR = "apple-eventkit"
export const CALENDAR_EVENT_MIME = "application/x-eido-calendar-event"

/** The interval each run reads, relative to now. The gate refuses more than 366 days. */
export const APPLE_CALENDAR_WINDOW = { pastDays: 14, futureDays: 180 } as const

/** Longest source ref the API schemas carry (`AskCitation.sourceRef`). */
const MAX_SOURCE_REF_LENGTH = 500

const DAY_MS = 86_400_000

type AppleEvent = GateAppleEventList["events"][number]

export type AppleCalendarRun =
  | {
      calendarId: string
      status: "synced"
      fetched: number
      ingested: number
      retired: number
    }
  | { calendarId: string; status: "failed"; reason: string }
  /** Enabled by id but not listed by the Helper: nothing is read and nothing is retired. */
  | { calendarId: string; status: "missing" }

export interface AppleCalendarSyncResult {
  calendars: AppleCalendarRun[]
}

export interface AppleCalendarSyncOptions {
  db: DatabaseSync
  client: Pick<AppleClient, "listCalendars" | "listEvents">
  entities: IngestEntities
  selection: AppleCalendarSelection
  now?: () => Date
  /** Called for each enabled calendar the Helper lists, so the Profile page can assign it. */
  onCalendar?: (calendar: { id: string; title: string }) => void
}

/** The opaque link an indexed Apple event is cited by: its calendar and EventKit id. */
export function appleEventSourceRef(
  calendarId: string,
  eventId: string
): string {
  return `${APPLE_CALENDAR_CONNECTOR}://calendar/${encodeURIComponent(calendarId)}/event/${encodeURIComponent(eventId)}`
}

function eventDigest(event: AppleEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: APPLE_CALENDAR_CONNECTOR,
        calendarId: event.calendarId,
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        location: event.location,
        notes: event.notes,
        modifiedAt: event.modifiedAt,
      })
    )
    .digest("hex")
}

function eventDocument(event: AppleEvent, entityId: string): IndexedDocument {
  return {
    sha256: eventDigest(event),
    source: APPLE_CALENDAR_CONNECTOR,
    sourceRef: appleEventSourceRef(event.calendarId, event.id),
    mime: CALENDAR_EVENT_MIME,
    entityId,
    ...(event.title === "" ? {} : { title: event.title }),
    body: [event.title, event.location ?? "", event.notes ?? ""]
      .filter((part) => part !== "")
      .join("\n\n"),
    occurredAt: event.start,
  }
}

/**
 * Why `events` is not a whole snapshot of `calendarId`, or undefined when it is. A read the
 * Helper answered for another calendar, with a repeated id, or with an id too long to cite cannot
 * be reconciled against the index.
 */
function snapshotProblem(
  calendarId: string,
  events: readonly AppleEvent[]
): string | undefined {
  const seen = new Set<string>()
  for (const event of events) {
    if (event.calendarId !== calendarId) return "foreign_calendar_event"
    if (seen.has(event.id)) return "duplicate_event_id"
    seen.add(event.id)
    if (
      appleEventSourceRef(calendarId, event.id).length > MAX_SOURCE_REF_LENGTH
    )
      return "event_id_too_long"
  }
  return undefined
}

function recordEventFacts(
  db: DatabaseSync,
  events: readonly AppleEvent[]
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO calendar_event_facts
       (sha256, source, calendar_id, event_id, start_at, end_at, all_day)
     SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM documents WHERE sha256 = ?)`
  )
  for (const event of events) {
    const digest = eventDigest(event)
    insert.run(
      digest,
      APPLE_CALENDAR_CONNECTOR,
      event.calendarId,
      event.id,
      event.start,
      event.end,
      event.allDay ? 1 : 0,
      digest
    )
  }
}

/**
 * Current heads of `calendarId` that lie wholly inside [start, end] and are not in `kept`. Only
 * these are known gone: an event reaching outside the interval may not be in the snapshot.
 */
function headsToRetire(
  db: DatabaseSync,
  calendarId: string,
  start: number,
  end: number,
  kept: ReadonlySet<string>
): string[] {
  const rows = db
    .prepare(
      `SELECT h.source_ref, f.start_at, f.end_at
       FROM document_heads h
       JOIN calendar_event_facts f ON f.sha256 = h.sha256
       WHERE h.source = ? AND f.source = ? AND f.calendar_id = ?`
    )
    .all(APPLE_CALENDAR_CONNECTOR, APPLE_CALENDAR_CONNECTOR, calendarId)
  return rows
    .filter(
      (row) =>
        !kept.has(String(row["source_ref"])) &&
        Date.parse(String(row["start_at"])) >= start &&
        Date.parse(String(row["end_at"])) <= end
    )
    .map((row) => String(row["source_ref"]))
}

async function entityFor(
  entities: IngestEntities,
  calendarId: string
): Promise<string | null> {
  const assigned = await entities.entityForAccount(
    APPLE_CALENDAR_CONNECTOR,
    calendarId
  )
  return assigned?.id ?? (await entities.getDefaultEntityId())
}

async function syncCalendar(
  options: AppleCalendarSyncOptions,
  calendarId: string,
  start: Date,
  end: Date
): Promise<AppleCalendarRun> {
  const { db, client } = options
  // Refuse before reading: with no entity nothing can be stored, and nothing is retired.
  const entityId = await entityFor(options.entities, calendarId)
  if (entityId === null)
    return { calendarId, status: "failed", reason: "entity_required" }
  const interval = { start: start.toISOString(), end: end.toISOString() }
  let events: AppleEvent[]
  try {
    events = (await client.listEvents({ calendarId, ...interval })).events
  } catch (error) {
    return {
      calendarId,
      status: "failed",
      reason: error instanceof Error ? error.message : "unknown error",
    }
  }
  const problem = snapshotProblem(calendarId, events)
  if (problem !== undefined)
    return { calendarId, status: "failed", reason: problem }

  const documents = events.map((event) => eventDocument(event, entityId))
  return writeQueueFor(db).run(() => {
    const kept = new Set(documents.map((doc) => doc.sourceRef))
    const retired = headsToRetire(
      db,
      calendarId,
      start.getTime(),
      end.getTime(),
      kept
    )
    const heads: DocumentHeadChange[] = [
      ...documents.map((doc) => ({
        source: APPLE_CALENDAR_CONNECTOR,
        sourceRef: doc.sourceRef,
        sha256: doc.sha256,
      })),
      ...retired.map((sourceRef) => ({
        source: APPLE_CALENDAR_CONNECTOR,
        sourceRef,
        sha256: null,
      })),
    ]
    const result = ingestBatch(db, {
      connector: APPLE_CALENDAR_CONNECTOR,
      stream: `calendar:${calendarId}`,
      documents,
      heads,
      nextCursor: JSON.stringify(interval),
    })
    recordEventFacts(db, events)
    return {
      calendarId,
      status: "synced" as const,
      fetched: events.length,
      ingested: result.inserted,
      retired: retired.length,
    }
  })
}

/**
 * Read each enabled Apple calendar over the sync window and reconcile the index with it. A
 * successful read is a complete snapshot of its own calendar and interval only: events of that
 * calendar wholly inside the interval and missing from it are retired. A failed, refused or
 * malformed read changes nothing for its calendar; the other calendars still sync.
 */
export async function syncAppleCalendars(
  options: AppleCalendarSyncOptions
): Promise<AppleCalendarSyncResult> {
  const now = (options.now ?? (() => new Date()))()
  const start = new Date(
    now.getTime() - APPLE_CALENDAR_WINDOW.pastDays * DAY_MS
  )
  const end = new Date(
    now.getTime() + APPLE_CALENDAR_WINDOW.futureDays * DAY_MS
  )
  const listed = (await options.client.listCalendars()).calendars
  const byId = new Map(listed.map((calendar) => [calendar.id, calendar]))
  const wanted =
    options.selection.kind === "all"
      ? listed.map((calendar) => calendar.id)
      : options.selection.ids
  const calendars: AppleCalendarRun[] = []
  for (const calendarId of wanted) {
    const calendar = byId.get(calendarId)
    if (calendar === undefined) {
      calendars.push({ calendarId, status: "missing" })
      continue
    }
    options.onCalendar?.({ id: calendar.id, title: calendar.title })
    calendars.push(await syncCalendar(options, calendarId, start, end))
  }
  return { calendars }
}

/** Whether `eventId` is an indexed Apple event id. Such an id is never a Proton invitation UID. */
export function isAppleEventId(db: DatabaseSync, eventId: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM calendar_event_facts WHERE source = ? AND event_id = ? LIMIT 1"
      )
      .get(APPLE_CALENDAR_CONNECTOR, eventId) !== undefined
  )
}
