import { describe, expect, test } from "vitest"
import { addDays, daysBetween, localParts, parseTime } from "./local-time"

describe("local time", () => {
  test("reads the local date and minutes in the timezone, across midnight", () => {
    const at = new Date("2026-11-02T23:30:00.000Z")
    expect(localParts(at, "Europe/Zurich")).toEqual({
      date: "2026-11-03",
      minutes: 30,
    })
    expect(localParts(at, "America/New_York")).toEqual({
      date: "2026-11-02",
      minutes: 18 * 60 + 30,
    })
  })

  test("follows daylight saving time", () => {
    expect(
      localParts(new Date("2026-07-01T05:00:00.000Z"), "Europe/Zurich")
    ).toEqual({
      date: "2026-07-01",
      minutes: 7 * 60,
    })
  })

  test("refuses an invalid timezone and an invalid date", () => {
    expect(() => localParts(new Date(), "Mars/Base")).toThrow(RangeError)
    expect(() => localParts(new Date(NaN), "Etc/UTC")).toThrow(RangeError)
  })

  test("parses HH:MM and refuses other times", () => {
    expect(parseTime("07:05")).toBe(425)
    for (const bad of ["7:00", "24:00", "07:60", "noon"])
      expect(() => parseTime(bad)).toThrow(RangeError)
  })

  test("counts and adds calendar days over a month and a leap day", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3)
    expect(daysBetween("2026-11-02", "2026-10-30")).toBe(-3)
    expect(addDays("2028-02-28", 2)).toBe("2028-03-01")
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02")
  })
})
