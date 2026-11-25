import type { DatabaseSync } from "node:sqlite"
import { getCursor, ingestBatch } from "../../index/index"
import { APPLE_CALENDAR_CONNECTOR } from "./connector"

/**
 * An enabled calendar the Helper does not list is retired once it has been missing from this many
 * runs in a row (twelve runs, an hour at the five-minute cadence). One run is no proof: the Helper
 * can list a short set while the Calendar store is loading. Any run that lists it again starts the
 * count over.
 */
export const MISSING_RUNS_BEFORE_RETIRE = 12

function missingStream(calendarId: string): string {
  return `missing:${calendarId}`
}

/** The calendars that have at least one live (not retired) Apple event head. */
export function indexedCalendarIds(db: DatabaseSync): string[] {
  return db
    .prepare(
      `SELECT DISTINCT f.calendar_id FROM document_heads h
       JOIN calendar_event_facts f ON f.sha256 = h.sha256 AND f.source = h.source
       WHERE h.source = ?
       ORDER BY f.calendar_id`
    )
    .all(APPLE_CALENDAR_CONNECTOR)
    .map((row) => String(row["calendar_id"]))
}

/**
 * Retires every live head of `calendarId`, whatever its time. Returns how many. Call it inside the
 * database's write queue.
 */
export function retireCalendar(db: DatabaseSync, calendarId: string): number {
  const refs = db
    .prepare(
      `SELECT h.source_ref FROM document_heads h
       JOIN calendar_event_facts f ON f.sha256 = h.sha256 AND f.source = h.source
       WHERE h.source = ? AND f.calendar_id = ?`
    )
    .all(APPLE_CALENDAR_CONNECTOR, calendarId)
    .map((row) => String(row["source_ref"]))
  const stream = `calendar:${calendarId}`
  ingestBatch(db, {
    connector: APPLE_CALENDAR_CONNECTOR,
    stream,
    documents: [],
    heads: refs.map((sourceRef) => ({
      source: APPLE_CALENDAR_CONNECTOR,
      sourceRef,
      sha256: null,
    })),
    nextCursor: getCursor(db, APPLE_CALENDAR_CONNECTOR, stream)?.cursor ?? "",
  })
  return refs.length
}

/**
 * Counts one more run that did not list `calendarId`, and returns the number of runs in a row.
 * Call it inside the database's write queue.
 */
export function noteMissingRun(db: DatabaseSync, calendarId: string): number {
  const stream = missingStream(calendarId)
  const runs =
    Number(getCursor(db, APPLE_CALENDAR_CONNECTOR, stream)?.cursor ?? 0) + 1
  db.prepare(
    `INSERT INTO cursors (connector, stream, cursor, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (connector, stream) DO UPDATE SET
       cursor = excluded.cursor, updated_at = excluded.updated_at`
  ).run(
    APPLE_CALENDAR_CONNECTOR,
    stream,
    String(runs),
    new Date().toISOString()
  )
  return runs
}

/** Forgets the missing runs of `calendarId`. Call it inside the database's write queue. */
export function clearMissingRuns(db: DatabaseSync, calendarId: string): void {
  db.prepare("DELETE FROM cursors WHERE connector = ? AND stream = ?").run(
    APPLE_CALENDAR_CONNECTOR,
    missingStream(calendarId)
  )
}
