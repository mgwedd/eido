import { describe, expect, test } from "vitest"
import {
  filterDueSoon,
  formatDueText,
  limitDueSoon,
  obligationStatusChip,
  sortDueSoon,
  type DueSoonEntry,
} from "../lib/today-due-soon"

const NOW = new Date(2026, 9, 31, 12) // Oct 31, 2026

function makeEntry(
  id: number,
  dueAt: string,
  entityId: string,
  direction: "owed" | "waiting" | null = null
): DueSoonEntry {
  return {
    id,
    dueAt,
    action: `Action ${id}`,
    party: `Party ${id}`,
    direction,
    entity: {
      id: entityId,
      name: entityId === "e1" ? "Personal" : "Rental",
      kind: "personal",
      tag: entityId,
    },
    source: {
      documentId: "a".repeat(64),
      span: { start: 10, end: 50 },
    },
  }
}

describe("formatDueText", () => {
  test("overdue dates show days overdue in red (long and short forms)", () => {
    // Oct 28 is 3 days before Oct 31
    const long3 = formatDueText("2026-10-28", NOW, "long")
    expect(long3.text).toBe("3 days overdue")
    expect(long3.isOverdue).toBe(true)

    const short3 = formatDueText("2026-10-28", NOW, "short")
    expect(short3.text).toBe("3 d overdue")
    expect(short3.isOverdue).toBe(true)

    // Oct 30 is 1 day overdue
    const long1 = formatDueText("2026-10-30", NOW, "long")
    expect(long1.text).toBe("1 day overdue")
    expect(long1.isOverdue).toBe(true)

    const short1 = formatDueText("2026-10-30", NOW, "short")
    expect(short1.text).toBe("1 d overdue")
    expect(short1.isOverdue).toBe(true)
  })

  test("dates within 30 days show Mon D · in N days (desktop) and Mon D (phone)", () => {
    // Oct 31 is in 0 days (today)
    const todayLong = formatDueText("2026-10-31", NOW, "long")
    expect(todayLong.text).toBe("Oct 31 · in 0 days")
    expect(todayLong.isOverdue).toBe(false)

    const todayShort = formatDueText("2026-10-31", NOW, "short")
    expect(todayShort.text).toBe("Oct 31")
    expect(todayShort.isOverdue).toBe(false)

    // Nov 1 is in 1 day
    const day1Long = formatDueText("2026-11-01", NOW, "long")
    expect(day1Long.text).toBe("Nov 1 · in 1 day")
    expect(day1Long.isOverdue).toBe(false)

    // Nov 3 is in 3 days
    const day3Long = formatDueText("2026-11-03", NOW, "long")
    expect(day3Long.text).toBe("Nov 3 · in 3 days")
    expect(day3Long.isOverdue).toBe(false)

    const day3Short = formatDueText("2026-11-03", NOW, "short")
    expect(day3Short.text).toBe("Nov 3")
    expect(day3Short.isOverdue).toBe(false)
  })

  test("dates beyond 30 days show date alone, adding year only when different", () => {
    // Dec 15 is > 30 days, same year (2026)
    const sameYear = formatDueText("2026-12-15", NOW, "long")
    expect(sameYear.text).toBe("Dec 15")
    expect(sameYear.isOverdue).toBe(false)

    const sameYearShort = formatDueText("2026-12-15", NOW, "short")
    expect(sameYearShort.text).toBe("Dec 15")

    // Jan 15, 2027 is > 30 days, different year
    const diffYear = formatDueText("2027-01-15", NOW, "long")
    expect(diffYear.text).toBe("Jan 15, 2027")
    expect(diffYear.isOverdue).toBe(false)

    const diffYearShort = formatDueText("2027-01-15", NOW, "short")
    expect(diffYearShort.text).toBe("Jan 15, 2027")
  })
})

describe("obligationStatusChip", () => {
  test("open obligation with pending draft intent shows Draft ready", () => {
    expect(
      obligationStatusChip({
        status: "open",
        hasPendingDraft: true,
      })
    ).toEqual({ label: "Draft ready", variant: "draft-ready" })
  })

  test("open obligation with direction waiting shows Tracking", () => {
    expect(
      obligationStatusChip({
        status: "open",
        direction: "waiting",
      })
    ).toEqual({ label: "Tracking", variant: "tracking" })
  })

  test("open obligation with owed or null direction shows Open", () => {
    expect(
      obligationStatusChip({
        status: "open",
        direction: "owed",
      })
    ).toEqual({ label: "Open", variant: "open" })

    expect(
      obligationStatusChip({
        status: "open",
        direction: null,
      })
    ).toEqual({ label: "Open", variant: "open" })
  })

  test("Draft ready takes precedence over Tracking", () => {
    expect(
      obligationStatusChip({
        status: "open",
        direction: "waiting",
        hasPendingDraft: true,
      })
    ).toEqual({ label: "Draft ready", variant: "draft-ready" })
  })

  test("done and dismissed render as neutral", () => {
    expect(obligationStatusChip({ status: "done" })).toEqual({
      label: "Done",
      variant: "neutral",
    })
    expect(obligationStatusChip({ status: "dismissed" })).toEqual({
      label: "Dismissed",
      variant: "neutral",
    })
  })

  test("unexpected status renders with raw text", () => {
    expect(obligationStatusChip({ status: "escalated" })).toEqual({
      label: "escalated",
      variant: "neutral",
    })
  })
})

describe("filterDueSoon", () => {
  const entries = [
    makeEntry(1, "2026-11-01", "e1"),
    makeEntry(2, "2026-11-02", "e2"),
    makeEntry(3, "2026-11-03", "e1"),
  ]

  test("all returns all entries", () => {
    expect(filterDueSoon(entries, "all")).toHaveLength(3)
    expect(filterDueSoon(entries, "")).toHaveLength(3)
  })

  test("filters by entity id", () => {
    const e1Only = filterDueSoon(entries, "e1")
    expect(e1Only).toHaveLength(2)
    expect(e1Only.map((e) => e.id)).toEqual([1, 3])

    const e2Only = filterDueSoon(entries, "e2")
    expect(e2Only).toHaveLength(1)
    expect(e2Only[0]?.id).toBe(2)
  })
})

describe("sortDueSoon", () => {
  test("sorts by dueAt ascending (overdue first), then by id", () => {
    const entries = [
      makeEntry(3, "2026-11-05", "e1"),
      makeEntry(1, "2026-10-25", "e1"), // overdue
      makeEntry(2, "2026-11-01", "e1"),
      makeEntry(4, "2026-10-25", "e1"), // overdue same day, higher id
    ]
    const sorted = sortDueSoon(entries)
    expect(sorted.map((e) => e.id)).toEqual([1, 4, 2, 3])
  })
})

describe("limitDueSoon", () => {
  test("limits to count", () => {
    const entries = [1, 2, 3, 4, 5, 6].map((i) =>
      makeEntry(i, `2026-11-0${i}`, "e1")
    )
    expect(limitDueSoon(entries, 5)).toHaveLength(5)
    expect(limitDueSoon(entries, 3)).toHaveLength(3)
  })
})
