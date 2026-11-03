import { describe, expect, test } from "vitest"
import { localDay } from "./day"

describe("localDay", () => {
  test("an ordinary day runs from local midnight to the next", () => {
    expect(localDay(new Date("2026-11-02T12:00:00Z"), "Europe/Zurich")).toEqual(
      {
        date: "2026-11-02",
        start: "2026-11-01T23:00:00.000Z",
        end: "2026-11-02T23:00:00.000Z",
      }
    )
  })

  test("the spring-forward day is 23 hours long", () => {
    const day = localDay(new Date("2026-03-08T18:00:00Z"), "America/New_York")
    expect(day).toEqual({
      date: "2026-03-08",
      start: "2026-03-08T05:00:00.000Z",
      end: "2026-03-09T04:00:00.000Z",
    })
  })

  test("the fall-back day is 25 hours long", () => {
    const day = localDay(new Date("2026-11-01T18:00:00Z"), "America/New_York")
    expect(day).toEqual({
      date: "2026-11-01",
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-11-02T05:00:00.000Z",
    })
  })

  test("an instant just before local midnight belongs to the earlier date", () => {
    expect(
      localDay(new Date("2026-11-02T04:59:59Z"), "America/New_York").date
    ).toBe("2026-11-01")
    expect(
      localDay(new Date("2026-11-02T05:00:00Z"), "America/New_York").date
    ).toBe("2026-11-02")
  })

  test("a zone ahead of UTC finds its own midnight", () => {
    expect(
      localDay(new Date("2026-06-01T20:00:00Z"), "Pacific/Auckland")
    ).toEqual({
      date: "2026-06-02",
      start: "2026-06-01T12:00:00.000Z",
      end: "2026-06-02T12:00:00.000Z",
    })
  })
})
