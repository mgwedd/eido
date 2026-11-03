import { describe, expect, it } from "vitest"
import type { ObligationItem } from "@/lib/ledger"
import {
  getRepliesUrl,
  getReplySubject,
  partitionReplies,
  sortReplies,
} from "@/lib/replies"

function makeObligation(partial: Partial<ObligationItem>): ObligationItem {
  return {
    id: 1,
    action: "Test action",
    party: "Alice",
    dueAt: "2026-04-01",
    status: "open",
    direction: "owed",
    entity: { id: "ent-1", name: "Personal", tag: "personal" },
    source: {
      documentId: "a".repeat(64),
      span: { start: 0, end: 10 },
      title: "Thread Subject",
    },
    ...partial,
  }
}

describe("lib/replies", () => {
  describe("getReplySubject", () => {
    it("prefers source title when present", () => {
      const item = makeObligation({
        action: "Waiting on Alice: Something else",
        source: {
          documentId: "a".repeat(64),
          span: { start: 0, end: 10 },
          title: "Urgent: Project review",
        },
      })
      expect(getReplySubject(item)).toBe("Urgent: Project review")
    })

    it("strips Waiting on prefix when title is missing", () => {
      const item = makeObligation({
        action: "Waiting on Contractor: Roofing estimate",
        direction: "waiting",
        source: {
          documentId: "a".repeat(64),
          span: { start: 0, end: 10 },
        },
      })
      expect(getReplySubject(item)).toBe("Roofing estimate")
    })

    it("strips Reply to prefix when title is missing and has colon", () => {
      const item = makeObligation({
        action: "Reply to Tenant: Dishwasher repair",
        direction: "owed",
        source: {
          documentId: "a".repeat(64),
          span: { start: 0, end: 10 },
        },
      })
      expect(getReplySubject(item)).toBe("Dishwasher repair")
    })

    it("falls back to action when title is missing and no prefix matched", () => {
      const item = makeObligation({
        action: "Plain action text",
        source: {
          documentId: "a".repeat(64),
          span: { start: 0, end: 10 },
        },
      })
      expect(getReplySubject(item)).toBe("Plain action text")
    })

    it("handles whitespace or empty matched prefixes gracefully", () => {
      const waitingEmpty = makeObligation({
        action: "Waiting on Contractor:   ",
        direction: "waiting",
        source: {
          documentId: "a".repeat(64),
          span: { start: 0, end: 10 },
        },
      })
      expect(getReplySubject(waitingEmpty)).toBe("Waiting on Contractor:   ")

      const owedEmpty = makeObligation({
        action: "Reply to Tenant:   ",
        direction: "owed",
        source: {
          documentId: "a".repeat(64),
          span: { start: 0, end: 10 },
        },
      })
      expect(getReplySubject(owedEmpty)).toBe("Reply to Tenant:   ")

      const emptyTitle = makeObligation({
        action: "Some action",
        source: {
          documentId: "a".repeat(64),
          span: { start: 0, end: 10 },
          title: "   ",
        },
      })
      expect(getReplySubject(emptyTitle)).toBe("Some action")
    })
  })

  describe("sortReplies", () => {
    const now = new Date("2026-04-10T12:00:00Z")

    it("sorts overdue items first, then due date ascending, with nulls last", () => {
      const overdue1 = makeObligation({ id: 10, dueAt: "2026-04-05" })
      const overdue2 = makeObligation({ id: 2, dueAt: "2026-04-08" })
      const future1 = makeObligation({ id: 3, dueAt: "2026-04-15" })
      const future2 = makeObligation({ id: 4, dueAt: "2026-04-20" })
      const noDue = makeObligation({ id: 5, dueAt: null })

      const sorted = sortReplies(
        [future2, noDue, overdue2, future1, overdue1],
        now
      )

      expect(sorted.map((item) => item.id)).toEqual([10, 2, 3, 4, 5])
    })

    it("breaks ties with id ascending", () => {
      const itemA = makeObligation({ id: 3, dueAt: "2026-04-15" })
      const itemB = makeObligation({ id: 1, dueAt: "2026-04-15" })

      const sorted = sortReplies([itemA, itemB], now)
      expect(sorted.map((item) => item.id)).toEqual([1, 3])
    })

    it("handles both null due dates and comparisons with null", () => {
      const nullA = makeObligation({ id: 2, dueAt: null })
      const nullB = makeObligation({ id: 1, dueAt: null })
      const sortedNulls = sortReplies([nullA, nullB], now)
      expect(sortedNulls.map((item) => item.id)).toEqual([1, 2])

      const dated = makeObligation({ id: 5, dueAt: "2026-05-01" })
      const mixed1 = sortReplies([nullA, dated], now)
      expect(mixed1.map((item) => item.id)).toEqual([5, 2])

      const mixed2 = sortReplies([dated, nullA], now)
      expect(mixed2.map((item) => item.id)).toEqual([5, 2])
    })
  })

  describe("partitionReplies", () => {
    it("partitions items by direction and skips null direction", () => {
      const owed = makeObligation({ id: 1, direction: "owed" })
      const waiting = makeObligation({ id: 2, direction: "waiting" })
      const neither = makeObligation({ id: 3, direction: null })

      const result = partitionReplies([owed, waiting, neither])
      expect(result.owed.map((item) => item.id)).toEqual([1])
      expect(result.waiting.map((item) => item.id)).toEqual([2])
    })
  })

  describe("getRepliesUrl", () => {
    it("returns /ledger/replies without entity or when all", () => {
      expect(getRepliesUrl()).toBe("/ledger/replies")
      expect(getRepliesUrl("all")).toBe("/ledger/replies")
    })

    it("returns /ledger/replies?entity=... with entity", () => {
      expect(getRepliesUrl("ent-prop")).toBe("/ledger/replies?entity=ent-prop")
    })
  })
})
