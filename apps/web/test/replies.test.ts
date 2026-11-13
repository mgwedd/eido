import { afterEach, describe, expect, it, vi } from "vitest"
import type { Connector } from "@/lib/connectors"
import type { ObligationItem } from "@/lib/ledger"
import {
  getPartialCoverageNotice,
  getRepliesUrl,
  getReplySubject,
  moveRowFocus,
  partitionReplies,
  requestDraftReply,
  requestResolveObligation,
  resolveFailureMessage,
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

    const DRAFT_BODY = {
      intentId: "intent-9",
      tier: "auto",
      state: "approved",
      activityHref: "/activity?intent=intent-9",
    }

    function stubDraftFetch(status: number, body: unknown) {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          })
        )
      )
      vi.stubGlobal("fetch", fetchMock)
      return fetchMock
    }

    it("POSTs the obligation id to core's draft route through the proxy", async () => {
      const fetchMock = stubDraftFetch(201, { ...DRAFT_BODY, created: true })

      await requestDraftReply(7)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ]
      expect(url).toBe("/api/core/replies/draft")
      expect(init.method).toBe("POST")
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : "")
      ).toEqual({ obligationId: 7 })
    })

    it("201 is a new saved draft linking to its Activity entry", async () => {
      stubDraftFetch(201, { ...DRAFT_BODY, created: true })
      expect(await requestDraftReply(7)).toEqual({
        status: "saved",
        activityHref: "/activity?intent=intent-9",
        created: true,
      })
    })

    it("200 is the thread's existing draft, not a second one", async () => {
      stubDraftFetch(200, { ...DRAFT_BODY, created: false })
      expect(await requestDraftReply(7)).toEqual({
        status: "saved",
        activityHref: "/activity?intent=intent-9",
        created: false,
      })
    })

    it.each([
      [404, "not_found"],
      [422, "invalid"],
      [409, "invalid_transition"],
      [409, "connector_paused"],
      [422, "no_draft"],
      [503, "busy"],
      [503, "gate_unavailable"],
      [403, "forbidden"],
    ] as const)(
      "%i %s is a failure carrying core's code",
      async (status, code) => {
        stubDraftFetch(status, { error: { code, message: "core's words" } })
        expect(await requestDraftReply(7)).toEqual({
          status: "failed",
          reason: code,
        })
      }
    )

    it("401 is unauthenticated", async () => {
      stubDraftFetch(401, { error: "Unauthorized" })
      expect(await requestDraftReply(7)).toEqual({
        status: "failed",
        reason: "unauthenticated",
      })
    })

    it("a network failure is not a saved draft", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new TypeError("network")))
      )
      expect(await requestDraftReply(7)).toEqual({
        status: "failed",
        reason: "network",
      })
    })

    it("a 2xx body that is not a reply-draft response is not a saved draft", async () => {
      stubDraftFetch(201, { id: "intent-9" })
      expect(await requestDraftReply(7)).toEqual({
        status: "failed",
        reason: "unreadable",
      })
    })

    it("an error status with an unreadable body is a failure", async () => {
      stubDraftFetch(502, "<html>bad gateway</html>")
      expect(await requestDraftReply(7)).toEqual({
        status: "failed",
        reason: "unreadable",
      })
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

  describe("moveRowFocus", () => {
    const ids = [4, 7, 9]

    it("lands on the first row from nothing, whichever key", () => {
      expect(moveRowFocus(ids, null, "next")).toBe(4)
      expect(moveRowFocus(ids, null, "previous")).toBe(4)
    })

    it("steps and stops at both ends", () => {
      expect(moveRowFocus(ids, 4, "next")).toBe(7)
      expect(moveRowFocus(ids, 9, "next")).toBe(9)
      expect(moveRowFocus(ids, 9, "previous")).toBe(7)
      expect(moveRowFocus(ids, 4, "previous")).toBe(4)
    })

    it("restarts at the first row when the focused id is gone", () => {
      expect(moveRowFocus(ids, 5, "next")).toBe(4)
    })

    it("has no focus without rows", () => {
      expect(moveRowFocus([], null, "next")).toBeNull()
    })
  })

  describe("requestResolveObligation", () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function stubResolve(status: number, body: unknown) {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          })
        )
      )
      vi.stubGlobal("fetch", fetchMock)
      return fetchMock
    }
    const errorBody = (code: string) => ({
      error: { code, message: "for logs" },
    })

    it("POSTs to the obligation's resolve route and reports resolved on a done answer", async () => {
      const fetchMock = stubResolve(200, { id: 7, status: "done" })

      expect(await requestResolveObligation(7)).toEqual({ status: "resolved" })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ]
      expect(url).toBe("/api/core/obligations/7/resolve")
      expect(init.method).toBe("POST")
    })

    it.each([
      ["another obligation's id", { id: 8, status: "done" }],
      ["a status other than done", { id: 7, status: "open" }],
      ["a body that is not an obligation state", { ok: true }],
    ])("does not count %s as resolved", async (_name, body) => {
      stubResolve(200, body)
      expect(await requestResolveObligation(7)).toEqual({
        status: "failed",
        reason: "unreadable",
      })
    })

    it("reports core's error code", async () => {
      stubResolve(409, errorBody("invalid_transition"))
      expect(await requestResolveObligation(7)).toEqual({
        status: "failed",
        reason: "invalid_transition",
      })
    })

    it("reports a 401 as unauthenticated, an unreadable body, and a network failure", async () => {
      stubResolve(401, {})
      expect(await requestResolveObligation(7)).toEqual({
        status: "failed",
        reason: "unauthenticated",
      })

      stubResolve(500, "<html>")
      expect(await requestResolveObligation(7)).toEqual({
        status: "failed",
        reason: "unreadable",
      })

      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new TypeError("offline")))
      )
      expect(await requestResolveObligation(7)).toEqual({
        status: "failed",
        reason: "network",
      })
    })

    it("reports a 403 body as forbidden", async () => {
      stubResolve(403, errorBody("forbidden"))
      expect(await requestResolveObligation(7)).toEqual({
        status: "failed",
        reason: "forbidden",
      })
    })

    it("words each failure for the row", () => {
      expect(resolveFailureMessage("forbidden")).toBe(
        "You do not have access to resolve threads."
      )
      expect(resolveFailureMessage("not_found")).toBe(
        "This thread is gone. Reload the page."
      )
      expect(resolveFailureMessage("invalid_transition")).toBe(
        "This thread is no longer open. Reload the page."
      )
      expect(resolveFailureMessage("unauthenticated")).toBe(
        "Sign in again to mark this resolved."
      )
      expect(resolveFailureMessage("network")).toBe(
        "Connection lost. Nothing was changed. Try again."
      )
      expect(resolveFailureMessage("unreadable")).toBe(
        "Could not mark this resolved. Nothing was changed. Try again."
      )
    })
  })
})
