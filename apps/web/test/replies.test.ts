import { afterEach, describe, expect, it, vi } from "vitest"
import type { Connector } from "@/lib/connectors"
import type { ObligationItem } from "@/lib/ledger"
import {
  DRAFT_REPLY_URL,
  getPartialCoverageNotice,
  getRepliesUrl,
  getReplySubject,
  partitionReplies,
  requestDraftReply,
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

  describe("requestDraftReply", () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it("POSTs to /api/ask with threadId and returns intentId", async () => {
      let calledUrl = ""
      let calledBody: unknown = null
      let calledMethod = ""

      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          calledUrl = String(input)
          calledMethod = init?.method ?? ""
          calledBody = JSON.parse(String(init?.body))
          return Promise.resolve(
            new Response(JSON.stringify({ intentId: "intent-123" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        })
      )

      const result = await requestDraftReply({ threadId: "thread-xyz" })
      expect(calledUrl).toBe(DRAFT_REPLY_URL)
      expect(calledMethod).toBe("POST")
      expect(calledBody).toEqual({
        threadId: "thread-xyz",
        thread_id: "thread-xyz",
      })
      expect(result).toEqual({ ok: true, intentId: "intent-123" })
    })

    it("handles id from response data.id or data.intent.id", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                id: "gate-intent-456",
                tier: "auto",
                state: "approved",
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            )
          )
        )
      )

      const res1 = await requestDraftReply({ threadId: "t-1" })
      expect(res1).toEqual({ ok: true, intentId: "gate-intent-456" })

      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                intent: { id: "nested-789", kind: "email.draft" },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            )
          )
        )
      )

      const res2 = await requestDraftReply({ threadId: "t-2" })
      expect(res2).toEqual({ ok: true, intentId: "nested-789" })
    })

    it("handles custom url override", async () => {
      let calledUrl = ""
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          calledUrl = String(input)
          return Promise.resolve(
            new Response(JSON.stringify({ intentId: "i-custom" }), {
              status: 200,
            })
          )
        })
      )

      const res = await requestDraftReply({
        threadId: "t-custom",
        url: "/api/core/ask",
      })
      expect(calledUrl).toBe("/api/core/ask")
      expect(res.ok).toBe(true)
    })

    it("returns ok: false on HTTP error status", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify({ error: "Server down" }), {
              status: 503,
            })
          )
        )
      )

      const result = await requestDraftReply({ threadId: "thread-xyz" })
      expect(result.ok).toBe(false)
      expect(result.error).toContain("503")
    })

    it("returns ok: false on network rejection", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new Error("Connection refused")))
      )

      const result = await requestDraftReply({ threadId: "thread-xyz" })
      expect(result.ok).toBe(false)
      expect(result.error).toBe("Connection refused")
    })

    it("handles abort signal cleanly", async () => {
      const controller = new AbortController()
      controller.abort()

      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new DOMException("Aborted", "AbortError")))
      )

      const result = await requestDraftReply(
        { threadId: "thread-xyz" },
        controller.signal
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe("Aborted")
    })
  })

  describe("getPartialCoverageNotice", () => {
    const makeConnector = (partial: Partial<Connector>): Connector => ({
      name: "proton-mail",
      enabled: true,
      pinnedAt: "2026-01-01T00:00:00Z",
      scopes: [],
      health: "healthy",
      consecutiveFailures: 0,
      manifestHash: "abc",
      ...partial,
    })

    it("returns null when no connectors or all healthy", () => {
      expect(getPartialCoverageNotice([])).toBeNull()
      expect(
        getPartialCoverageNotice([
          makeConnector({ name: "proton-mail", health: "healthy" }),
          makeConnector({ name: "gmail", health: "healthy" }),
        ])
      ).toBeNull()
    })

    it("returns notice when proton-mail is paused or unhealthy", () => {
      expect(
        getPartialCoverageNotice([
          makeConnector({ name: "proton-mail", health: "open" }),
        ])
      ).toBe("Proton Mail paused: its threads are not included.")

      expect(
        getPartialCoverageNotice([
          makeConnector({ name: "proton-mail", health: "degraded" }),
        ])
      ).toBe("Proton Mail paused: its threads are not included.")

      expect(
        getPartialCoverageNotice([
          makeConnector({ name: "proton-mail", enabled: false }),
        ])
      ).toBe("Proton Mail paused: its threads are not included.")
    })

    it("returns notice when gmail is paused or disabled", () => {
      expect(
        getPartialCoverageNotice([
          makeConnector({ name: "gmail", health: "open" }),
        ])
      ).toBe("Gmail paused: its threads are not included.")
    })

    it("ignores non-mail connectors", () => {
      expect(
        getPartialCoverageNotice([
          makeConnector({ name: "drive", health: "open" }),
        ])
      ).toBeNull()
    })
  })
})
