import { describe, expect, test } from "vitest"
import { validateCoreApiTodayEvents } from "."

// Synthetic events only.
const event = {
  id: "event-1",
  title: "Dentist",
  start: "2030-05-01T09:00:00.000Z",
  end: "2030-05-01T10:00:00.000Z",
  allDay: false,
}
const day = { timezone: "Europe/Berlin", date: "2030-05-01" }

describe("Today events API schema", () => {
  test("a day with no events is valid", () => {
    expect(validateCoreApiTodayEvents({ ...day, events: [] }).ok).toBe(true)
  })

  test("a timed event and an event with an empty title are valid", () => {
    expect(
      validateCoreApiTodayEvents({
        ...day,
        events: [event, { ...event, id: "event-2", title: "" }],
      }).ok
    ).toBe(true)
  })

  test("an event without allDay is rejected", () => {
    const withoutAllDay = {
      id: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
    }
    expect(
      validateCoreApiTodayEvents({ ...day, events: [withoutAllDay] }).ok
    ).toBe(false)
  })

  test("a calendar name or other extra field on an event is rejected", () => {
    expect(
      validateCoreApiTodayEvents({
        ...day,
        events: [{ ...event, calendar: "Home" }],
      }).ok
    ).toBe(false)
  })

  test("a date that is not YYYY-MM-DD is rejected", () => {
    expect(
      validateCoreApiTodayEvents({ ...day, date: "1 May 2030", events: [] }).ok
    ).toBe(false)
  })

  test("a title over 200 characters is rejected", () => {
    expect(
      validateCoreApiTodayEvents({
        ...day,
        events: [{ ...event, title: "x".repeat(201) }],
      }).ok
    ).toBe(false)
  })
})
