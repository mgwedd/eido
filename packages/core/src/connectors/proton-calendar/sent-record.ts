import type { DatabaseSync } from "node:sqlite"
import type { CalendarCreateIntent, CalendarEditIntent } from "@eido/schemas"
import { deriveEventUid } from "./builder"

export type AttendeeRead =
  { ok: true; attendees: readonly string[] } | { ok: false; notFound?: boolean }

export type StoredAttendees = (eventUid: string) => AttendeeRead

export type SentCalendarEvent = {
  eventUid: string
  sequence: number
  lastMethod: "REQUEST" | "CANCEL"
  entity: string
  category?: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
  description?: string
  guests: readonly string[]
  attendees: readonly string[]
  createdAt: string
  updatedAt: string
}

export interface CalendarSentRecordStore {
  get(eventUid: string): SentCalendarEvent | undefined
  save(event: SentCalendarEvent): void
  has(eventUid: string): boolean
  recordCreate(
    args: CalendarCreateIntent["args"],
    ownerAddress: string,
    now?: string
  ): SentCalendarEvent
  recordEdit(args: CalendarEditIntent["args"], now?: string): SentCalendarEvent
  recordDelete(eventUid: string, now?: string): SentCalendarEvent
  all(): SentCalendarEvent[]
}

export function createMemorySentRecordStore(): CalendarSentRecordStore {
  const store = new Map<string, SentCalendarEvent>()

  return {
    get: (uid) => store.get(uid),
    save: (event) => {
      store.set(event.eventUid, event)
    },
    has: (uid) => store.has(uid),
    recordCreate: (args, ownerAddress, now = new Date().toISOString()) => {
      const uid = deriveEventUid(args)
      const attendees = [ownerAddress, ...(args.guests ?? [])]
      const event: SentCalendarEvent = {
        eventUid: uid,
        sequence: 0,
        lastMethod: "REQUEST",
        entity: args.entity,
        category: args.category,
        title: args.title,
        start: args.start,
        end: args.end,
        allDay: args.allDay,
        location: args.location,
        description: args.description,
        guests: args.guests ?? [],
        attendees,
        createdAt: now,
        updatedAt: now,
      }
      store.set(uid, event)
      return event
    },
    recordEdit: (args, now = new Date().toISOString()) => {
      const existing = store.get(args.eventUid)
      if (!existing) {
        throw new Error(`cannot edit unknown event ${args.eventUid}`)
      }
      const guests = args.guests ?? existing.guests
      const attendees = [existing.attendees[0] ?? "", ...guests]
      const updated: SentCalendarEvent = {
        ...existing,
        sequence: existing.sequence + 1,
        lastMethod: "REQUEST",
        entity: args.entity ?? existing.entity,
        category: args.category ?? existing.category,
        title: args.title ?? existing.title,
        start: args.start ?? existing.start,
        end: args.end ?? existing.end,
        allDay: args.allDay !== undefined ? args.allDay : existing.allDay,
        location: args.location ?? existing.location,
        description: args.description ?? existing.description,
        guests,
        attendees,
        updatedAt: now,
      }
      store.set(args.eventUid, updated)
      return updated
    },
    recordDelete: (eventUid, now = new Date().toISOString()) => {
      const existing = store.get(eventUid)
      if (!existing) {
        throw new Error(`cannot delete unknown event ${eventUid}`)
      }
      const updated: SentCalendarEvent = {
        ...existing,
        sequence: existing.sequence + 1,
        lastMethod: "CANCEL",
        updatedAt: now,
      }
      store.set(eventUid, updated)
      return updated
    },
    all: () => Array.from(store.values()),
  }
}

function parseStringArray(json: string): string[] {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value)) return []
  return value.filter((x): x is string => typeof x === "string")
}

export function initSqliteSentRecordSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sent_calendar_events (
      event_uid TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      last_method TEXT NOT NULL,
      entity TEXT NOT NULL,
      category TEXT,
      title TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      all_day INTEGER NOT NULL,
      location TEXT,
      description TEXT,
      guests_json TEXT NOT NULL,
      attendees_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `)
}

export function createSqliteSentRecordStore(
  db: DatabaseSync
): CalendarSentRecordStore {
  initSqliteSentRecordSchema(db)

  return {
    get: (uid) => {
      const row = db
        .prepare("SELECT * FROM sent_calendar_events WHERE event_uid = ?")
        .get(uid)
      if (!row) return undefined
      return {
        eventUid: String(row["event_uid"]),
        sequence: Number(row["sequence"]),
        lastMethod: row["last_method"] as "REQUEST" | "CANCEL",
        entity: String(row["entity"]),
        category: row["category"] ? String(row["category"]) : undefined,
        title: String(row["title"]),
        start: String(row["start_time"]),
        end: String(row["end_time"]),
        allDay: Boolean(row["all_day"]),
        location: row["location"] ? String(row["location"]) : undefined,
        description: row["description"]
          ? String(row["description"])
          : undefined,
        guests: parseStringArray(String(row["guests_json"])),
        attendees: parseStringArray(String(row["attendees_json"])),
        createdAt: String(row["created_at"]),
        updatedAt: String(row["updated_at"]),
      }
    },
    save: (event) => {
      db.prepare(
        `INSERT OR REPLACE INTO sent_calendar_events (
          event_uid, sequence, last_method, entity, category, title, start_time, end_time,
          all_day, location, description, guests_json, attendees_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        event.eventUid,
        event.sequence,
        event.lastMethod,
        event.entity,
        event.category ?? null,
        event.title,
        event.start,
        event.end,
        event.allDay ? 1 : 0,
        event.location ?? null,
        event.description ?? null,
        JSON.stringify(event.guests),
        JSON.stringify(event.attendees),
        event.createdAt,
        event.updatedAt
      )
    },
    has: (uid) => {
      const row = db
        .prepare("SELECT 1 FROM sent_calendar_events WHERE event_uid = ?")
        .get(uid)
      return row !== undefined
    },
    recordCreate: (args, ownerAddress, now = new Date().toISOString()) => {
      const uid = deriveEventUid(args)
      const attendees = [ownerAddress, ...(args.guests ?? [])]
      const event: SentCalendarEvent = {
        eventUid: uid,
        sequence: 0,
        lastMethod: "REQUEST",
        entity: args.entity,
        category: args.category,
        title: args.title,
        start: args.start,
        end: args.end,
        allDay: args.allDay,
        location: args.location,
        description: args.description,
        guests: args.guests ?? [],
        attendees,
        createdAt: now,
        updatedAt: now,
      }
      db.prepare(
        `INSERT OR REPLACE INTO sent_calendar_events (
          event_uid, sequence, last_method, entity, category, title, start_time, end_time,
          all_day, location, description, guests_json, attendees_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        event.eventUid,
        event.sequence,
        event.lastMethod,
        event.entity,
        event.category ?? null,
        event.title,
        event.start,
        event.end,
        event.allDay ? 1 : 0,
        event.location ?? null,
        event.description ?? null,
        JSON.stringify(event.guests),
        JSON.stringify(event.attendees),
        event.createdAt,
        event.updatedAt
      )
      return event
    },
    recordEdit: (args, now = new Date().toISOString()) => {
      const row = db
        .prepare("SELECT * FROM sent_calendar_events WHERE event_uid = ?")
        .get(args.eventUid)
      if (!row) {
        throw new Error(`cannot edit unknown event ${args.eventUid}`)
      }
      const existingAttendees = parseStringArray(String(row["attendees_json"]))
      const existingGuests = parseStringArray(String(row["guests_json"]))
      const guests = args.guests ?? existingGuests
      const attendees = [existingAttendees[0] ?? "", ...guests]
      const nextSequence = Number(row["sequence"]) + 1

      const updated: SentCalendarEvent = {
        eventUid: args.eventUid,
        sequence: nextSequence,
        lastMethod: "REQUEST",
        entity: args.entity ?? String(row["entity"]),
        category:
          args.category ??
          (row["category"] ? String(row["category"]) : undefined),
        title: args.title ?? String(row["title"]),
        start: args.start ?? String(row["start_time"]),
        end: args.end ?? String(row["end_time"]),
        allDay:
          args.allDay !== undefined ? args.allDay : Boolean(row["all_day"]),
        location:
          args.location ??
          (row["location"] ? String(row["location"]) : undefined),
        description:
          args.description ??
          (row["description"] ? String(row["description"]) : undefined),
        guests,
        attendees,
        createdAt: String(row["created_at"]),
        updatedAt: now,
      }

      db.prepare(
        `UPDATE sent_calendar_events SET
          sequence = ?, last_method = ?, entity = ?, category = ?, title = ?, start_time = ?,
          end_time = ?, all_day = ?, location = ?, description = ?, guests_json = ?,
          attendees_json = ?, updated_at = ?
         WHERE event_uid = ?`
      ).run(
        updated.sequence,
        updated.lastMethod,
        updated.entity,
        updated.category ?? null,
        updated.title,
        updated.start,
        updated.end,
        updated.allDay ? 1 : 0,
        updated.location ?? null,
        updated.description ?? null,
        JSON.stringify(updated.guests),
        JSON.stringify(updated.attendees),
        updated.updatedAt,
        args.eventUid
      )

      return updated
    },
    recordDelete: (eventUid, now = new Date().toISOString()) => {
      const row = db
        .prepare("SELECT * FROM sent_calendar_events WHERE event_uid = ?")
        .get(eventUid)
      if (!row) {
        throw new Error(`cannot delete unknown event ${eventUid}`)
      }
      const nextSequence = Number(row["sequence"]) + 1

      db.prepare(
        "UPDATE sent_calendar_events SET sequence = ?, last_method = 'CANCEL', updated_at = ? WHERE event_uid = ?"
      ).run(nextSequence, now, eventUid)

      return {
        eventUid,
        sequence: nextSequence,
        lastMethod: "CANCEL",
        entity: String(row["entity"]),
        category: row["category"] ? String(row["category"]) : undefined,
        title: String(row["title"]),
        start: String(row["start_time"]),
        end: String(row["end_time"]),
        allDay: Boolean(row["all_day"]),
        location: row["location"] ? String(row["location"]) : undefined,
        description: row["description"]
          ? String(row["description"])
          : undefined,
        guests: parseStringArray(String(row["guests_json"])),
        attendees: parseStringArray(String(row["attendees_json"])),
        createdAt: String(row["created_at"]),
        updatedAt: now,
      }
    },
    all: () => {
      const rows = db
        .prepare("SELECT * FROM sent_calendar_events ORDER BY created_at ASC")
        .all()
      return rows.map((row) => ({
        eventUid: String(row["event_uid"]),
        sequence: Number(row["sequence"]),
        lastMethod: row["last_method"] as "REQUEST" | "CANCEL",
        entity: String(row["entity"]),
        category: row["category"] ? String(row["category"]) : undefined,
        title: String(row["title"]),
        start: String(row["start_time"]),
        end: String(row["end_time"]),
        allDay: Boolean(row["all_day"]),
        location: row["location"] ? String(row["location"]) : undefined,
        description: row["description"]
          ? String(row["description"])
          : undefined,
        guests: parseStringArray(String(row["guests_json"])),
        attendees: parseStringArray(String(row["attendees_json"])),
        createdAt: String(row["created_at"]),
        updatedAt: String(row["updated_at"]),
      }))
    },
  }
}

/**
 * Creates a StoredAttendees lookup function for Gate's PolicyOptions.
 * If the event is unknown (not created by Eido), returns { ok: false, notFound: true },
 * which Policy treats as forbidden("event_not_found").
 */
export function createStoredAttendeesReader(
  store: CalendarSentRecordStore
): StoredAttendees {
  return (eventUid: string): AttendeeRead => {
    const event = store.get(eventUid)
    if (event === undefined) {
      return { ok: false, notFound: true }
    }
    return { ok: true, attendees: event.attendees }
  }
}
