import { describe, expect, test } from "vitest"
import { parseAppleCalendarSelection } from "./config"

describe("parseAppleCalendarSelection", () => {
  test.each([undefined, "", "   "])(
    "%j turns Apple calendar sync off",
    (value) => {
      expect(parseAppleCalendarSelection(value)).toBeUndefined()
    }
  )

  test("* selects every listed calendar", () => {
    expect(parseAppleCalendarSelection(" * ")).toEqual({ kind: "all" })
  })

  test("a comma list is trimmed and de-duplicated in order", () => {
    expect(parseAppleCalendarSelection("cal-b, cal-a ,cal-b")).toEqual({
      kind: "ids",
      ids: ["cal-b", "cal-a"],
    })
  })

  test.each(["cal-a,,cal-b", "cal-a,", "x".repeat(1025)])(
    "%j is refused",
    (value) => {
      expect(() => parseAppleCalendarSelection(value)).toThrow(
        "EIDO_APPLE_CALENDARS must be * or a comma-separated list of calendar ids"
      )
    }
  )
})
