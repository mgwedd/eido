import { describe, expect, it } from "vitest"
import { allDayDate, appleEventDatesError } from "./apple-dates"

describe("allDayDate", () => {
  it.each([
    ["2026-03-10T00:00:00Z", "2026-03-10"],
    ["2026-03-10T00:00:00+09:00", "2026-03-10"],
    ["2026-03-10T00:00:00-08:00", "2026-03-10"],
  ])("reads %s as the date written, ignoring the offset", (value, date) => {
    expect(allDayDate(value)).toBe(date)
  })

  it.each([
    "2026-03-10T09:00:00Z",
    "2026-03-10T00:00:00.000Z",
    "2026-03-10T00:00:01+09:00",
    "2026-03-10",
  ])("refuses %s, which is not a midnight date-time", (value) => {
    expect(allDayDate(value)).toBeUndefined()
  })
})

describe("appleEventDatesError", () => {
  it("compares a timed event's bounds as instants, offsets included", () => {
    expect(
      appleEventDatesError({
        allDay: false,
        start: "2026-03-10T10:00:00Z",
        end: "2026-03-10T11:00:00+01:00",
      })
    ).toBe("$.args.end: must be later than start")
    expect(
      appleEventDatesError({
        allDay: false,
        start: "2026-03-10T10:00:00Z",
        end: "2026-03-10T10:00:01Z",
      })
    ).toBeUndefined()
  })

  it("accepts a one-day all-day event whose end is the next date, exclusive", () => {
    expect(
      appleEventDatesError({
        allDay: true,
        start: "2026-03-10T00:00:00Z",
        end: "2026-03-11T00:00:00Z",
      })
    ).toBeUndefined()
  })

  it("compares all-day bounds by written date, not by instant", () => {
    expect(
      appleEventDatesError({
        allDay: true,
        start: "2026-03-10T00:00:00-12:00",
        end: "2026-03-11T00:00:00+14:00",
      })
    ).toBeUndefined()
    expect(
      appleEventDatesError({
        allDay: true,
        start: "2026-03-10T00:00:00+14:00",
        end: "2026-03-10T00:00:00-12:00",
      })
    ).toBe("$.args.end: an all-day end date must be later than start's date")
  })

  it("names the bound that is not midnight", () => {
    expect(
      appleEventDatesError({
        allDay: true,
        start: "2026-03-10T08:00:00Z",
        end: "2026-03-11T00:00:00Z",
      })
    ).toBe("$.args.start: an all-day start must be midnight (T00:00:00)")
    expect(
      appleEventDatesError({
        allDay: true,
        start: "2026-03-10T00:00:00Z",
        end: "2026-03-10T23:59:59Z",
      })
    ).toBe("$.args.end: an all-day end must be midnight (T00:00:00)")
  })
})
