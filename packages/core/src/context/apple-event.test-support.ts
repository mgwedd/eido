// Test support for Apple event details: marks indexed events as read by a sync that stored their
// location and notes. Imported by tests only.
import type { DatabaseSync } from "node:sqlite"

/** An indexed Apple event the Helper would write: no attendees, not recurring. */
export const WRITABLE = { hasAttendees: false, recurring: false } as const

/**
 * Store the location and notes of the indexed Apple event `uid`, as the sync that first reads them
 * does (`details_known` goes from 0 to 1, the one change the fact row allows).
 */
export function knowEventDetails(
  db: DatabaseSync,
  uid: string,
  details: { location: string | null; notes: string | null }
): void {
  db.prepare(
    `UPDATE calendar_event_facts SET details_known = 1, location = ?, notes = ?
     WHERE source = 'apple-eventkit' AND event_id = ?`
  ).run(details.location, details.notes, uid)
}
