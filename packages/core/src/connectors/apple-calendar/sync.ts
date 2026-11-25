import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { AppleClient } from "@eido/gate"
import type { GateAppleEventList } from "@eido/schemas"
import { writeQueueFor } from "../../db/write-queue"
import { ingestBatch } from "../../index/index"
import type { DocumentHeadChange, IndexedDocument } from "../../index/index"
import type { IngestEntities } from "../ingest-entity"
import type { AppleCalendarSelection } from "./config"
import { APPLE_CALENDAR_CONNECTOR } from "./connector"
import {
  MISSING_RUNS_BEFORE_RETIRE,
  clearMissingRuns,
  indexedCalendarIds,
  noteMissingRun,
  retireCalendar,
} from "./unread"

export { APPLE_CALENDAR_CONNECTOR }
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
      /** Items the Helper reported it left out of the read (`skipped`). */
      skipped: number
      /** Items core left out: another calendar's, a repeated id, or an id too long to cite. */
      dropped: number
    }
  | { calendarId: string; status: "failed"; reason: AppleCalendarFailure }
  /**
   * Indexed or enabled by id, but not listed by the Helper: nothing is read. `missedRuns` is how
   * many runs in a row have not listed an indexed calendar (0 when none of its events is indexed);
   * at `MISSING_RUNS_BEFORE_RETIRE` its events are retired and `retired` counts them.
   */
  | {
      calendarId: string
      status: "missing"
      missedRuns: number
      retired: number
    }

/** Fixed reason codes: a gate error message never reaches the log. */
export type AppleCalendarFailure = "entity_required" | "read_failed"

export interface AppleCalendarSyncResult {
  calendars: AppleCalendarRun[]
  /**
   * Calendars with indexed events that `EIDO_APPLE_CALENDARS` no longer names: every event of each
   * is retired at once, with the count.
   */
  disabled: { calendarId: string; retired: number }[]
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
 * The events of `events` that can be indexed for `calendarId`, and how many were dropped. An item
 * the Helper answered for another calendar, an id it returned more than once (every copy, since
 * neither can be trusted), and an id too long to cite are dropped; the rest of the read still counts.
 */
function usableEvents(
  calendarId: string,
  events: readonly AppleEvent[]
): { usable: AppleEvent[]; dropped: number } {
  const counts = new Map<string, number>()
  for (const event of events)
    counts.set(event.id, (counts.get(event.id) ?? 0) + 1)
  const usable = events.filter(
    (event) =>
      event.calendarId === calendarId &&
      counts.get(event.id) === 1 &&
      appleEventSourceRef(calendarId, event.id).length <= MAX_SOURCE_REF_LENGTH
  )
  return { usable, dropped: events.length - usable.length }
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
 * Current heads of `calendarId` that overlap (start, end) and are not in `kept`. The Helper reads
 * with EventKit's `predicateForEvents`, which returns every event overlapping the interval, so a
 * whole read that lacks such a head shows it is gone, even when it starts before the interval or
 * ends after it. A head that ends at or before `start` (or starts at or after `end`) is outside
 * the interval: the read says nothing about it, so it is kept as history.
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
        Date.parse(String(row["start_at"])) < end &&
        Date.parse(String(row["end_at"])) > start
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
  let list: GateAppleEventList
  try {
    list = await client.listEvents({ calendarId, ...interval })
  } catch {
    return { calendarId, status: "failed", reason: "read_failed" }
  }
  const { usable: events, dropped } = usableEvents(calendarId, list.events)
  const skipped = list.skipped ?? 0
  // A read the Helper or core left items out of is not a whole snapshot: index it, retire nothing.
  const complete = skipped === 0 && dropped === 0

  const documents = events.map((event) => eventDocument(event, entityId))
  return writeQueueFor(db).run(() => {
    const kept = new Set(documents.map((doc) => doc.sourceRef))
    const retired = complete
      ? headsToRetire(db, calendarId, start.getTime(), end.getTime(), kept)
      : []
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
      fetched: list.events.length,
      ingested: result.inserted,
      retired: retired.length,
      skipped,
      dropped,
    }
  })
}

/**
 * A calendar the Helper did not list. Its events are retired only after it has been missing from
 * `MISSING_RUNS_BEFORE_RETIRE` runs in a row: one short listing is not proof it is gone.
 */
function missingCalendar(
  db: DatabaseSync,
  calendarId: string,
  indexed: boolean
): Promise<AppleCalendarRun> {
  return writeQueueFor(db).run(() => {
    if (!indexed)
      return {
        calendarId,
        status: "missing" as const,
        missedRuns: 0,
        retired: 0,
      }
    const missedRuns = noteMissingRun(db, calendarId)
    if (missedRuns < MISSING_RUNS_BEFORE_RETIRE)
      return { calendarId, status: "missing" as const, missedRuns, retired: 0 }
    const retired = retireCalendar(db, calendarId)
    clearMissingRuns(db, calendarId)
    return { calendarId, status: "missing" as const, missedRuns, retired }
  })
}

/**
 * Read each enabled Apple calendar over the sync window and reconcile the index with it. A
 * successful read is a complete snapshot of its own calendar and interval: events of that calendar
 * that overlap the interval and are missing from it are retired; events ending before the interval
 * are past and kept as history. A read that reports skipped items, or has items core cannot index,
 * indexes the rest and retires nothing. A failed or refused read changes nothing for its calendar;
 * the other calendars still sync, and a failed calendar listing (a Calendar permission error, say)
 * changes nothing at all.
 *
 * Calendars with indexed events that are no longer read are retired too: one that
 * `EIDO_APPLE_CALENDARS` no longer names, at once (the owner chose it); one the Helper no longer
 * lists, after `MISSING_RUNS_BEFORE_RETIRE` runs in a row.
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
  const { db, selection } = options
  const listed = (await options.client.listCalendars()).calendars
  const byId = new Map(listed.map((calendar) => [calendar.id, calendar]))
  const indexed = new Set(indexedCalendarIds(db))
  const wanted =
    selection.kind === "all"
      ? [
          ...listed.map((calendar) => calendar.id),
          ...[...indexed].filter((id) => !byId.has(id)),
        ]
      : selection.ids
  const calendars: AppleCalendarRun[] = []
  for (const calendarId of wanted) {
    const calendar = byId.get(calendarId)
    if (calendar === undefined) {
      calendars.push(
        await missingCalendar(db, calendarId, indexed.has(calendarId))
      )
      continue
    }
    await writeQueueFor(db).run(() => clearMissingRuns(db, calendarId))
    options.onCalendar?.({ id: calendar.id, title: calendar.title })
    calendars.push(await syncCalendar(options, calendarId, start, end))
  }
  const enabled = new Set(wanted)
  const disabled = [...indexed]
    .filter((calendarId) => !enabled.has(calendarId))
    .map((calendarId) => ({ calendarId }))
  const retiredDisabled = await writeQueueFor(db).run(() =>
    disabled.map(({ calendarId }) => {
      const retired = retireCalendar(db, calendarId)
      clearMissingRuns(db, calendarId)
      return { calendarId, retired }
    })
  )
  return { calendars, disabled: retiredDisabled }
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
