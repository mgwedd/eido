import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  createMemorySentRecordStore,
  createSqliteSentRecordStore,
  createStoredAttendeesReader,
} from "./sent-record"

describe("Calendar Sent Record Store", () => {
  describe("memory store", () => {
    it("records create, edit, delete and queries correctly", () => {
      const store = createMemorySentRecordStore()
      const owner = "owner@example.invalid"

      const createArgs = {
        entity: "Astrea Labs LLC",
        category: "Ops",
        title: "Staff Meeting",
        start: "2026-11-20T10:00:00Z",
        end: "2026-11-20T11:00:00Z",
        allDay: false,
        location: "Room 1",
        description: "Weekly staff sync",
        guests: ["guest@example.invalid"],
      }

      // 1. Create
      const created = store.recordCreate(createArgs, owner)
      expect(created.sequence).toBe(0)
      expect(created.lastMethod).toBe("REQUEST")
      expect(created.entity).toBe("Astrea Labs LLC")
      expect(created.category).toBe("Ops")
      expect(created.attendees).toEqual([owner, "guest@example.invalid"])
      expect(store.has(created.eventUid)).toBe(true)
      expect(store.get(created.eventUid)).toEqual(created)

      // 2. Stored attendees reader
      const reader = createStoredAttendeesReader(store)
      const readKnown = reader(created.eventUid)
      expect(readKnown).toEqual({
        ok: true,
        attendees: [owner, "guest@example.invalid"],
      })
      const readUnknown = reader("unknown-uid")
      expect(readUnknown).toEqual({ ok: false, notFound: true })

      // 3. Edit
      const edited = store.recordEdit({
        eventUid: created.eventUid,
        title: "Staff Meeting - Rescheduled",
        category: "Management",
      })
      expect(edited.sequence).toBe(1)
      expect(edited.title).toBe("Staff Meeting - Rescheduled")
      expect(edited.category).toBe("Management")
      expect(store.get(created.eventUid)?.sequence).toBe(1)

      // 4. Delete
      const deleted = store.recordDelete(created.eventUid)
      expect(deleted.sequence).toBe(2)
      expect(deleted.lastMethod).toBe("CANCEL")
      expect(store.get(created.eventUid)?.lastMethod).toBe("CANCEL")

      expect(store.all()).toHaveLength(1)

      // 5. Error cases on unknown UIDs
      expect(() =>
        store.recordEdit({ eventUid: "nonexistent", title: "X" })
      ).toThrow()
      expect(() => store.recordDelete("nonexistent")).toThrow()
    })
  })

  describe("sqlite store", () => {
    it("persists create, edit, delete across operations and reads attendees", () => {
      const db = new DatabaseSync(":memory:")
      const store = createSqliteSentRecordStore(db)
      const owner = "owner@example.invalid"

      const createArgs = {
        entity: "Factory Hill LLC",
        title: "Inspection",
        start: "2026-11-21T08:00:00Z",
        end: "2026-11-21T09:00:00Z",
        allDay: false,
      }

      const created = store.recordCreate(createArgs, owner)
      expect(created.sequence).toBe(0)
      expect(created.lastMethod).toBe("REQUEST")
      expect(created.entity).toBe("Factory Hill LLC")
      expect(store.has(created.eventUid)).toBe(true)

      const fetched = store.get(created.eventUid)
      expect(fetched?.title).toBe("Inspection")
      expect(fetched?.attendees).toEqual([owner])

      const reader = createStoredAttendeesReader(store)
      expect(reader(created.eventUid)).toEqual({ ok: true, attendees: [owner] })
      expect(reader("unknown-id")).toEqual({ ok: false, notFound: true })

      const edited = store.recordEdit({
        eventUid: created.eventUid,
        title: "Inspection - Morning",
        location: "Building 3",
      })
      expect(edited.sequence).toBe(1)
      expect(store.get(created.eventUid)?.location).toBe("Building 3")

      const deleted = store.recordDelete(created.eventUid)
      expect(deleted.sequence).toBe(2)
      expect(deleted.lastMethod).toBe("CANCEL")

      expect(store.all()).toHaveLength(1)

      expect(() => store.recordEdit({ eventUid: "bad-uid" })).toThrow()
      expect(() => store.recordDelete("bad-uid")).toThrow()
    })
  })
})
