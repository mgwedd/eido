import { describe, expect, it } from "vitest"
import {
  collectReferences,
  extractDates,
  extractTags,
  summaryHasDate,
  summaryHasTag,
  withPreservedReferences,
} from "./references"

describe("extractDates", () => {
  it.each([
    ["signed on 2025-10-31 in person", ["2025-10-31"]],
    ["sent 2025-10-31T09:30:00Z by mail", ["2025-10-31T09:30:00Z"]],
    ["due Oct 31", ["Oct 31"]],
    ["due October 31, 2025", ["October 31, 2025"]],
    ["due Oct. 3rd", ["Oct. 3rd"]],
    ["due 31 October", ["31 October"]],
    ["due 1st Nov 2026", ["1st Nov 2026"]],
    ["first Oct 31 then 2025-11-02", ["Oct 31", "2025-11-02"]],
    ["Oct 31 and Oct 31", ["Oct 31"]],
  ])("finds the dates in %j", (text, expected) => {
    expect(extractDates(text)).toEqual(expected)
  })

  it("does not read a month word or a plain number as a date", () => {
    expect(extractDates("we may go, version 2025 had 31 items")).toEqual([])
  })
})

describe("extractTags", () => {
  it("finds bracketed source tags only", () => {
    expect(
      extractTags("see [M3] and [CO12], not M4 or [lower1] or [M]")
    ).toEqual(["M3", "CO12"])
  })
})

describe("presence checks", () => {
  it("matches a date case-insensitively across whitespace", () => {
    expect(summaryHasDate("due oct   31 at noon", "Oct 31")).toBe(true)
    expect(summaryHasDate("due Oct 30", "Oct 31")).toBe(false)
  })

  it("matches a tag as a whole token", () => {
    expect(summaryHasTag("see [M3]", "M3")).toBe(true)
    expect(summaryHasTag("see M3.", "M3")).toBe(true)
    expect(summaryHasTag("see M30 and XM3", "M3")).toBe(false)
  })
})

describe("withPreservedReferences", () => {
  it("returns the summary untouched when everything is present", () => {
    const summary = "Meet Oct 31 about [M3]."
    expect(
      withPreservedReferences(summary, { dates: ["Oct 31"], tags: ["M3"] })
    ).toBe(summary)
  })

  it("appends only the missing references on a final line", () => {
    expect(
      withPreservedReferences("Meet Oct 31.", {
        dates: ["Oct 31", "2025-11-02"],
        tags: ["M3", "M4"],
      })
    ).toBe("Meet Oct 31.\nPreserved references: 2025-11-02; M3; M4")
  })
})

describe("collectReferences", () => {
  it("unions dates and tags from text and declared sources without repeats", () => {
    expect(
      collectReferences(
        ["call Oct 31 re [M3]", "again Oct 31 and 2025-11-02"],
        ["M3", "M7"]
      )
    ).toEqual({ dates: ["Oct 31", "2025-11-02"], tags: ["M3", "M7"] })
  })
})
