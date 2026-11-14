import { describe, expect, test } from "vitest"
import {
  validateGateAppleRequest,
  validateGateAppleResponse,
  validateGateAppleCalendarList,
  validateGateAppleEventList,
  validateGateAppleReminderList,
  validateIntent,
} from "./index"

const START = "2026-11-13T09:00:00Z"
const END = "2026-11-13T10:00:00Z"
const EVENT = {
  calendarId: "cal-1",
  title: "Planning",
  start: START,
  end: END,
  allDay: false,
}
const REQUESTS = [
  { operation: "list_calendars", args: {} },
  { operation: "list_reminder_lists", args: {} },
  {
    operation: "list_events",
    args: { calendarId: "cal-1", start: START, end: END },
  },
  {
    operation: "list_reminders",
    args: { listId: "list-1", completedSince: START },
  },
  { operation: "create_event", args: EVENT },
  { operation: "update_event", args: { id: "event-1", ...EVENT } },
  {
    operation: "create_reminder",
    args: { listId: "list-1", title: "Call back", due: START },
  },
  { operation: "complete_reminder", args: { id: "reminder-1" } },
]

describe("EventKit wire contract", () => {
  test.each(REQUESTS)(
    "accepts $operation and refuses extra authority",
    (request) => {
      expect(validateGateAppleRequest(request)).toEqual({
        ok: true,
        value: request,
      })
      expect(validateGateAppleRequest({ ...request, token: "secret" }).ok).toBe(
        false
      )
      expect(
        validateGateAppleRequest({
          ...request,
          args: { ...request.args, delete: true },
        }).ok
      ).toBe(false)
      expect(validateGateAppleRequest({ ...request, args: [] }).ok).toBe(false)
    }
  )
  test("has no delete or arbitrary native operation", () => {
    for (const operation of [
      "delete_event",
      "delete_reminder",
      "run",
      "authorize",
    ])
      expect(validateGateAppleRequest({ operation, args: {} }).ok).toBe(false)
  })
  test("requires bounded ids, titles and RFC3339 dates", () => {
    for (const args of [
      { ...EVENT, calendarId: "" },
      { ...EVENT, calendarId: "x".repeat(1025) },
      { ...EVENT, title: "" },
      { ...EVENT, title: "x".repeat(201) },
      { ...EVENT, start: "tomorrow" },
      { ...EVENT, allDay: "false" },
      { ...EVENT, notes: "x".repeat(20001) },
      { ...EVENT, location: "x".repeat(501) },
    ])
      expect(
        validateGateAppleRequest({ operation: "create_event", args }).ok
      ).toBe(false)
  })
  test("validates each distinct success shape and sanitized errors", () => {
    for (const result of [
      { calendars: [{ id: "cal-1", title: "Personal", writable: true }] },
      {
        events: [
          {
            id: "event-1",
            ...EVENT,
            notes: null,
            location: null,
            modifiedAt: null,
          },
        ],
      },
      {
        reminders: [
          {
            id: "reminder-1",
            listId: "list-1",
            title: "Call back",
            notes: null,
            due: null,
            completed: false,
            completedAt: null,
            modifiedAt: null,
          },
        ],
      },
      { id: "created-1" },
    ])
      expect(validateGateAppleResponse({ ok: true, result }).ok).toBe(true)
    for (const code of [
      "invalid_request",
      "permission_denied",
      "not_found",
      "read_only",
      "unsupported_event",
      "unavailable",
    ])
      expect(validateGateAppleResponse({ ok: false, code }).ok).toBe(true)
    for (const value of [
      { ok: true, result: { calendars: [], events: [] } },
      {
        ok: false,
        code: "permission_denied",
        message: "private calendar name",
      },
      { ok: false, code: "arbitrary" },
      { ok: true, result: { id: "" } },
    ])
      expect(validateGateAppleResponse(value).ok).toBe(false)
  })
  test("refuses malformed upstream records", () => {
    expect(
      validateGateAppleCalendarList({
        calendars: [{ id: "c", title: "Personal" }],
      }).ok
    ).toBe(false)
    expect(
      validateGateAppleEventList({
        events: [
          {
            id: "e",
            ...EVENT,
            notes: null,
            location: null,
            modifiedAt: "yesterday",
          },
        ],
      }).ok
    ).toBe(false)
    expect(
      validateGateAppleReminderList({
        reminders: [
          {
            id: "r",
            listId: "l",
            title: "Task",
            notes: null,
            due: null,
            completed: "yes",
            completedAt: null,
            modifiedAt: null,
          },
        ],
      }).ok
    ).toBe(false)
    expect(
      validateGateAppleEventList({
        events: new Array(2001).fill({
          id: "e",
          ...EVENT,
          notes: null,
          location: null,
          modifiedAt: null,
        }),
      }).ok
    ).toBe(false)
  })
})

describe("Apple intent authority", () => {
  test.each([
    { kind: "apple.event_create", args: EVENT },
    { kind: "apple.event_update", args: { id: "e", ...EVENT } },
    { kind: "apple.reminder_create", args: { listId: "l", title: "Task" } },
    { kind: "apple.reminder_complete", args: { id: "r" } },
  ])("validates $kind without allowing a connector substitution", (intent) => {
    expect(validateIntent(intent)).toEqual({ ok: true, value: intent })
    expect(validateIntent({ ...intent, connector: "proton-calendar" }).ok).toBe(
      false
    )
  })
  test("an event update is a complete replacement, not a patch with invented defaults", () => {
    expect(
      validateIntent({
        kind: "apple.event_update",
        args: { id: "e", title: "Moved" },
      }).ok
    ).toBe(false)
  })
})
