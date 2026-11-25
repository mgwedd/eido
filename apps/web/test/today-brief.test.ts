import { describe, expect, test } from "vitest"
import {
  deferredExtractionId,
  filterRenderableBriefLines,
  formatBriefDate,
  formatBriefHeaderMeta,
  formatBriefTime,
  isBriefFromEarlierDay,
  type BriefLine,
} from "../lib/today-brief"

describe("filterRenderableBriefLines", () => {
  test("retains lines with valid documentId and span", () => {
    const validLine: BriefLine = {
      kind: "due",
      text: "Rent is due tomorrow.",
      ledger: { type: "obligation", id: "1" },
      source: {
        documentId: "a".repeat(64),
        span: { start: 0, end: 10 },
      },
    }
    const filtered = filterRenderableBriefLines([validLine])
    expect(filtered).toHaveLength(1)
  })

  test("filters out lines without a valid source link", () => {
    const missingSource: BriefLine = {
      kind: "due",
      text: "No source line.",
      ledger: { type: "obligation", id: "1" },
      // @ts-expect-error testing invalid source
      source: undefined,
    }

    const shortDocId: BriefLine = {
      kind: "due",
      text: "Short doc ID.",
      ledger: { type: "obligation", id: "2" },
      source: {
        documentId: "short",
        span: { start: 0, end: 10 },
      },
    }

    const invalidSpan: BriefLine = {
      kind: "due",
      text: "Invalid span.",
      ledger: { type: "obligation", id: "3" },
      source: {
        documentId: "b".repeat(64),
        // @ts-expect-error testing invalid span
        span: null,
      },
    }

    const filtered = filterRenderableBriefLines([
      missingSource,
      shortDocId,
      invalidSpan,
    ])
    expect(filtered).toHaveLength(0)
  })

  test("retains more line", () => {
    const moreLine: BriefLine = {
      kind: "more",
      text: "3 more items in the ledger.",
      count: 3,
      ledger: { type: "ledger" },
    }
    expect(filterRenderableBriefLines([moreLine])).toHaveLength(1)
  })
})

describe("deferred lines in filterRenderableBriefLines", () => {
  const deferred = (
    type: "obligation" | "extraction",
    id: string
  ): BriefLine => ({
    kind: "deferred",
    text: "Lorem ipsum",
    ledger: { type, id },
  })

  test("keeps an obligation line and an extraction line with a numeric id", () => {
    const kept = filterRenderableBriefLines([
      deferred("obligation", "42"),
      deferred("extraction", "17"),
    ])
    expect(kept.map((line) => "ledger" in line && line.ledger)).toEqual([
      { type: "obligation", id: "42" },
      { type: "extraction", id: "17" },
    ])
  })

  test("drops an extraction line whose id cannot name an extraction row", () => {
    expect(
      filterRenderableBriefLines([
        deferred("extraction", "x1"),
        deferred("extraction", "0"),
        deferred("extraction", "-3"),
        deferred("extraction", "1.5"),
        deferred("extraction", "007"),
        deferred("extraction", "99999999999999999999"),
      ])
    ).toEqual([])
  })
})

describe("deferredExtractionId", () => {
  test("returns the number for an extraction line", () => {
    expect(
      deferredExtractionId({
        kind: "deferred",
        text: "Lorem ipsum",
        ledger: { type: "extraction", id: "17" },
      })
    ).toBe(17)
  })

  test("returns null for an obligation line", () => {
    expect(
      deferredExtractionId({
        kind: "deferred",
        text: "Lorem ipsum",
        ledger: { type: "obligation", id: "17" },
      })
    ).toBeNull()
  })
})

describe("formatBriefTime and formatBriefDate", () => {
  test("formatBriefTime formats ISO instant to local time string", () => {
    const time = formatBriefTime("2026-10-18T07:02:00.000Z")
    expect(typeof time).toBe("string")
    expect(time).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i)
  })

  test("formatBriefDate formats calendar date to Mon D", () => {
    expect(formatBriefDate("2026-10-17")).toBe("Oct 17")
    expect(formatBriefDate("2026-01-05")).toBe("Jan 5")
  })
})

describe("isBriefFromEarlierDay and formatBriefHeaderMeta", () => {
  const now = new Date(2026, 9, 18, 12) // Oct 18, 2026

  test("recognizes earlier day dates", () => {
    expect(isBriefFromEarlierDay("2026-10-17", now)).toBe(true)
    expect(isBriefFromEarlierDay("2026-10-18", now)).toBe(false)
    expect(isBriefFromEarlierDay("2026-10-19", now)).toBe(false)
  })

  test("shows generation time alone when brief is from today", () => {
    const meta = formatBriefHeaderMeta(
      { date: "2026-10-18", generatedAt: "2026-10-18T07:02:00.000Z" },
      now
    )
    expect(meta).not.toContain("Oct")
  })

  test("shows date and generation time when brief is from an earlier day", () => {
    const meta = formatBriefHeaderMeta(
      { date: "2026-10-17", generatedAt: "2026-10-17T07:02:00.000Z" },
      now
    )
    expect(meta).toContain("Oct 17 ·")
  })
})
