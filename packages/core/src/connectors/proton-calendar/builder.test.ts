import { describe, expect, it } from "vitest"
import type { CalendarCreateIntent } from "@eido/schemas"
import {
  buildCancelIcs,
  buildRequestIcs,
  deriveEventUid,
  foldLine,
  formatCategories,
  formatSummary,
  parseCategories,
  parseSummary,
  parseTags,
} from "./builder"
import { parseIcsFixture } from "./fixture-parser.test-support"

describe("Proton Calendar iCalendar Builder", () => {
  describe("deterministic UID", () => {
    it("the same intent always produces the same UID (deterministic, table-driven)", () => {
      const cases: Array<{
        name: string
        args: CalendarCreateIntent["args"]
        expectedUidPrefix: string
      }> = [
        {
          name: "basic single event",
          args: {
            entity: "Astrea Labs LLC",
            title: "Board Meeting",
            start: "2026-11-15T14:00:00Z",
            end: "2026-11-15T15:00:00Z",
            allDay: false,
          },
          expectedUidPrefix: "eido-cal-",
        },
        {
          name: "event with category and description",
          args: {
            entity: "Factory Hill LLC",
            category: "Legal",
            title: "Contract Review",
            start: "2026-11-16T10:00:00Z",
            end: "2026-11-16T11:00:00Z",
            allDay: false,
            description: "Review lease agreement terms",
            location: "Conference Room B",
          },
          expectedUidPrefix: "eido-cal-",
        },
        {
          name: "all-day event with guests",
          args: {
            entity: "Personal",
            title: "Family Vacation",
            start: "2026-12-01T00:00:00Z",
            end: "2026-12-05T00:00:00Z",
            allDay: true,
            guests: ["family@example.invalid", "friend@example.invalid"],
          },
          expectedUidPrefix: "eido-cal-",
        },
      ]

      for (const tc of cases) {
        const uid1 = deriveEventUid(tc.args)
        const uid2 = deriveEventUid(tc.args)
        expect(uid1, `determinism check for ${tc.name}`).toBe(uid2)
        expect(uid1.startsWith(tc.expectedUidPrefix)).toBe(true)
        expect(uid1).toMatch(
          /^eido-cal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        )
      }
    })

    it("different intents produce different UIDs", () => {
      const uidA = deriveEventUid({
        entity: "Personal",
        title: "Dentist",
        start: "2026-11-15T09:00:00Z",
        end: "2026-11-15T10:00:00Z",
        allDay: false,
      })
      const uidB = deriveEventUid({
        entity: "Personal",
        title: "Doctor",
        start: "2026-11-15T09:00:00Z",
        end: "2026-11-15T10:00:00Z",
        allDay: false,
      })
      expect(uidA).not.toBe(uidB)
    })
  })

  describe("sequence and undo progression", () => {
    it("each edit produces SEQUENCE one higher than previous message for that UID", () => {
      const uid = "eido-cal-test-progression-1234"
      const baseParams = {
        uid,
        title: "Product Sync",
        entity: "Astrea Labs LLC",
        start: "2026-11-20T16:00:00Z",
        end: "2026-11-20T17:00:00Z",
        allDay: false,
        organizer: { address: "assistant@example.invalid" },
        attendees: [{ address: "owner@example.invalid" }],
      }

      // Initial create: SEQUENCE 0
      const createIcs = buildRequestIcs({ ...baseParams, sequence: 0 })
      const parsedCreate = parseIcsFixture(createIcs)
      expect(parsedCreate.method).toBe("REQUEST")
      expect(parsedCreate.uid).toBe(uid)
      expect(parsedCreate.sequence).toBe(0)

      // First edit: SEQUENCE 1
      const edit1Ics = buildRequestIcs({
        ...baseParams,
        sequence: 1,
        title: "Product Sync - Rescheduled",
        start: "2026-11-20T17:00:00Z",
        end: "2026-11-20T18:00:00Z",
      })
      const parsedEdit1 = parseIcsFixture(edit1Ics)
      expect(parsedEdit1.sequence).toBe(1)
      expect(parsedEdit1.sequence).toBe(parsedCreate.sequence + 1)

      // Second edit: SEQUENCE 2
      const edit2Ics = buildRequestIcs({
        ...baseParams,
        sequence: 2,
        title: "Product Sync - Final",
        location: "Room 101",
      })
      const parsedEdit2 = parseIcsFixture(edit2Ics)
      expect(parsedEdit2.sequence).toBe(2)
      expect(parsedEdit2.sequence).toBe(parsedEdit1.sequence + 1)
    })

    it("undo of a create produces a METHOD:CANCEL with the same UID and a SEQUENCE higher than last sent", () => {
      const uid = "eido-cal-create-undo-999"
      const baseParams = {
        uid,
        title: "Lunch Meeting",
        entity: "Personal",
        start: "2026-11-18T12:00:00Z",
        end: "2026-11-18T13:00:00Z",
        allDay: false,
        organizer: { address: "assistant@example.invalid" },
        attendees: [{ address: "owner@example.invalid" }],
      }

      // Create was sent with sequence 0
      const createIcs = buildRequestIcs({ ...baseParams, sequence: 0 })
      const parsedCreate = parseIcsFixture(createIcs)
      expect(parsedCreate.method).toBe("REQUEST")
      expect(parsedCreate.sequence).toBe(0)

      // Undo of create: CANCEL with sequence 1 (higher than last sent 0)
      const cancelIcs = buildCancelIcs({
        ...baseParams,
        sequence: parsedCreate.sequence + 1,
      })
      const parsedCancel = parseIcsFixture(cancelIcs)
      expect(parsedCancel.method).toBe("CANCEL")
      expect(parsedCancel.uid).toBe(uid)
      expect(parsedCancel.status).toBe("CANCELLED")
      expect(parsedCancel.sequence).toBe(1)
      expect(parsedCancel.sequence).toBeGreaterThan(parsedCreate.sequence)
    })

    it("undo of an edit re-sends the prior body with a higher SEQUENCE", () => {
      const uid = "eido-cal-edit-undo-555"
      const originalParams = {
        uid,
        title: "Design Review",
        entity: "Factory Hill LLC",
        start: "2026-11-19T10:00:00Z",
        end: "2026-11-19T11:00:00Z",
        allDay: false,
        location: "Studio",
        organizer: { address: "assistant@example.invalid" },
        attendees: [{ address: "owner@example.invalid" }],
      }

      // 1. Initial create @ seq 0
      const createIcs = buildRequestIcs({ ...originalParams, sequence: 0 })
      const parsedCreate = parseIcsFixture(createIcs)
      expect(parsedCreate.sequence).toBe(0)

      // 2. Edit @ seq 1
      const editedIcs = buildRequestIcs({
        ...originalParams,
        sequence: 1,
        title: "Design Review - Moved Online",
        location: "Zoom",
      })
      const parsedEdit = parseIcsFixture(editedIcs)
      expect(parsedEdit.sequence).toBe(1)
      expect(parsedEdit.location).toBe("Zoom")

      // 3. Undo edit: re-sends prior body (Studio, original title) with seq 2
      const undoEditIcs = buildRequestIcs({
        ...originalParams,
        sequence: parsedEdit.sequence + 1,
      })
      const parsedUndo = parseIcsFixture(undoEditIcs)
      expect(parsedUndo.sequence).toBe(2)
      expect(parsedUndo.sequence).toBeGreaterThan(parsedEdit.sequence)
      expect(parsedUndo.summary).toBe("[Factory Hill LLC] Design Review")
      expect(parsedUndo.location).toBe("Studio")
      expect(parsedUndo.uid).toBe(uid)
    })
  })

  describe("tag round-trip", () => {
    it("the SUMMARY prefix and CATEGORIES property written for an entity and category parse back to the same entity and category", () => {
      const testCases = [
        {
          entity: "Factory Hill LLC",
          category: "Operations",
          title: "Warehouse Inventory Count",
        },
        {
          entity: "Astrea Labs LLC",
          category: "Accounting",
          title: "Quarterly Tax Filing",
        },
        {
          entity: "Personal",
          category: undefined,
          title: "Dentist Appointment",
        },
        {
          entity: "Alpha & Beta, Inc.",
          category: "Legal & Compliance",
          title: "Trademark Review",
        },
      ]

      for (const tc of testCases) {
        const summary = formatSummary(tc.title, tc.entity, tc.category)
        const categories = formatCategories(tc.entity, tc.category)

        // Parse back directly from summary
        const fromSummary = parseSummary(summary)
        expect(fromSummary.entity).toBe(tc.entity)
        expect(fromSummary.category).toBe(tc.category)
        expect(fromSummary.title).toBe(tc.title)

        // Parse back from categories
        const fromCategories = parseCategories(categories)
        expect(fromCategories.entity).toBe(tc.entity)
        expect(fromCategories.category).toBe(tc.category)

        // Combined parseTags
        const roundTripped = parseTags(summary, categories)
        expect(roundTripped.entity).toBe(tc.entity)
        expect(roundTripped.category).toBe(tc.category)
      }
    })
  })

  describe("fixture parser validation", () => {
    it("validates REQUEST with timed event and time zones", () => {
      const ics = buildRequestIcs({
        uid: "eido-cal-timed-tz-1",
        sequence: 0,
        dtstamp: "2026-11-02T12:00:00Z",
        title: "Strategy Session",
        entity: "Astrea Labs LLC",
        category: "Leadership",
        start: "2026-11-05T14:30:00-05:00", // EST (19:30 UTC)
        end: "2026-11-05T15:30:00-05:00", // EST (20:30 UTC)
        allDay: false,
        location: "HQ Boardroom",
        description: "Annual planning\nNotes to follow",
        organizer: {
          name: "Eido Assistant",
          address: "assistant@astrealabs.com",
        },
        attendees: [
          { name: "Owner", address: "owner@astrealabs.com" },
          { name: "Guest Alice", address: "alice@example.invalid" },
        ],
      })

      const parsed = parseIcsFixture(ics)
      expect(parsed.method).toBe("REQUEST")
      expect(parsed.status).toBe("CONFIRMED")
      expect(parsed.uid).toBe("eido-cal-timed-tz-1")
      expect(parsed.sequence).toBe(0)
      expect(parsed.summary).toBe(
        "[Astrea Labs LLC - Leadership] Strategy Session"
      )
      expect(parsed.isAllDay).toBe(false)
      expect(parsed.start.toISOString()).toBe("2026-11-05T19:30:00.000Z")
      expect(parsed.end.toISOString()).toBe("2026-11-05T20:30:00.000Z")
      expect(parsed.location).toBe("HQ Boardroom")
      expect(parsed.description).toContain("Annual planning\nNotes to follow")
      expect(parsed.organizer).toBe("mailto:assistant@astrealabs.com")
      expect(parsed.attendees).toHaveLength(2)
      expect(parsed.attendees[0]).toBe("mailto:owner@astrealabs.com")
      expect(parsed.attendees[1]).toBe("mailto:alice@example.invalid")
    })

    it("validates REQUEST with all-day events", () => {
      const ics = buildRequestIcs({
        uid: "eido-cal-allday-1",
        sequence: 0,
        dtstamp: "2026-11-02T12:00:00Z",
        title: "Company Offsite",
        entity: "Astrea Labs LLC",
        start: "2026-12-10T00:00:00Z",
        end: "2026-12-12T00:00:00Z",
        allDay: true,
        organizer: { address: "assistant@astrealabs.com" },
        attendees: [{ address: "owner@astrealabs.com" }],
      })

      const parsed = parseIcsFixture(ics)
      expect(parsed.method).toBe("REQUEST")
      expect(parsed.isAllDay).toBe(true)
      expect(parsed.uid).toBe("eido-cal-allday-1")
      expect(parsed.summary).toBe("[Astrea Labs LLC] Company Offsite")
    })

    it("validates CANCEL method and status", () => {
      const ics = buildCancelIcs({
        uid: "eido-cal-cancel-1",
        sequence: 3,
        dtstamp: "2026-11-02T12:00:00Z",
        title: "Cancelled Call",
        entity: "Personal",
        start: "2026-11-20T10:00:00Z",
        end: "2026-11-20T11:00:00Z",
        allDay: false,
        organizer: { address: "assistant@astrealabs.com" },
        attendees: [{ address: "owner@astrealabs.com" }],
      })

      const parsed = parseIcsFixture(ics)
      expect(parsed.method).toBe("CANCEL")
      expect(parsed.status).toBe("CANCELLED")
      expect(parsed.uid).toBe("eido-cal-cancel-1")
      expect(parsed.sequence).toBe(3)
    })

    it("folds long lines according to RFC 5545 section 3.1", () => {
      const veryLongText = "A".repeat(200)
      const folded = foldLine(`DESCRIPTION:${veryLongText}`)
      const lines = folded.split("\r\n")
      expect(lines.length).toBeGreaterThan(1)
      for (let i = 0; i < lines.length; i++) {
        expect(Buffer.byteLength(lines[i]!, "utf8")).toBeLessThanOrEqual(75)
        if (i > 0) {
          expect(lines[i]!.startsWith(" ")).toBe(true)
        }
      }
    })
  })
})
