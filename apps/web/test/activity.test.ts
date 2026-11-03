import { afterEach, describe, expect, test, vi } from "vitest"
import {
  ACCESS_AUDIT_LABELS,
  chainBrokenMessage,
  formatAction,
  groupByDay,
  intentHref,
  intentIdOf,
  loadAudit,
  loadChain,
  loadHistory,
  mergePage,
  mergeRefresh,
  nextCursor,
  rowKind,
  shortHash,
} from "../lib/activity"
import { canAccess } from "../lib/auth/access"
import {
  INTENT_ID,
  autoRow,
  chainBroken,
  chainOk,
  entry,
  history,
  intentRow,
  olderDayRow,
  rows,
} from "./fixtures/activity"

afterEach(() => vi.unstubAllGlobals())
const signal = () => new AbortController().signal
const stub = (impl: () => Promise<Response>) => {
  const fetchMock = vi.fn<typeof fetch>(impl)
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("row view-model", () => {
  test("shortHash is the first 8 hex characters", () => {
    expect(shortHash("c41a7e09" + "0".repeat(56))).toBe("c41a7e09")
  })

  test("only UUID targets are intents", () => {
    expect(intentIdOf(intentRow)).toBe(INTENT_ID)
    expect(intentIdOf(autoRow)).toBeNull()
    expect(intentHref(INTENT_ID)).toBe(`/activity?intent=${INTENT_ID}`)
  })

  test.each([
    ["alert.hash_mismatch", "alert"],
    ["policy.rejected", "refused"],
    ["intent.request_refused.invalid", "refused"],
    ["email.markRead", "normal"],
    ["intent.transition", "normal"],
    ["audit.access.document_open", "normal"],
    ["audit.access.inference_use", "normal"],
  ])("%s is %s", (action, kind) => expect(rowKind(action)).toBe(kind))

  test("formatAction maps audit.access.* actions to readable labels and passes others through", () => {
    expect(ACCESS_AUDIT_LABELS["audit.access.document_open"]).toBe(
      "Viewed document"
    )
    expect(formatAction("audit.access.document_open")).toBe("Viewed document")
    expect(formatAction("audit.access.inference_use")).toBe(
      "Local inference used"
    )
    expect(formatAction("audit.access.content_copy")).toBe("Copied text")
    expect(formatAction("audit.access.instruction_change")).toBe(
      "Updated assistant instructions"
    )
    expect(formatAction("audit.profile.entity.create")).toBe(
      "audit.profile.entity.create"
    )
    expect(formatAction("email.send")).toBe("email.send")
  })

  test("groups by local day, newest first, with Today and Yesterday labels", () => {
    const now = new Date(intentRow.ts)
    const groups = groupByDay([intentRow, autoRow, olderDayRow], now)
    expect(groups.map((g) => g.entries.map((e) => e.seq))).toEqual([
      [120, 117],
      [116],
    ])
    expect(groups[0]?.label).toBe("Today")
    expect(groups[1]?.label).not.toBe("Today")
    const next = new Date(now)
    next.setDate(now.getDate() + 1)
    expect(groupByDay([intentRow], next)[0]?.label).toBe("Yesterday")
  })
})

describe("paging", () => {
  test("mergePage appends without duplicates or gaps", () => {
    const first = rows(50, 51)
    const second = rows(50, 1)
    const merged = mergePage(first, [first[49]!, ...second])
    expect(merged.map((e) => e.seq)).toEqual(
      Array.from({ length: 100 }, (_, i) => 100 - i)
    )
  })

  test("the cursor is the lowest seq loaded, null on the last page", () => {
    expect(nextCursor(rows(50, 51), 51)).toBe(51)
    expect(nextCursor(rows(50, 51), undefined)).toBeNull()
    expect(nextCursor([], 5)).toBeNull()
  })
})

describe("refresh", () => {
  test("fresh rows replace the loaded top, older loaded rows and their cursor stay", () => {
    const loaded = rows(4, 1).map((e) =>
      e.seq === 3 ? { ...e, undo: "available" as const } : e
    )
    const fresh = [entry(5), entry(4), entry(3, { undo: "done" })]
    const merged = mergeRefresh(loaded, 1, fresh, 3)
    expect(merged.entries.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1])
    expect(merged.entries[2]?.undo).toBe("done")
    expect(merged.cursor).toBe(1)
  })

  test("when the fresh page covers everything loaded, its own cursor applies", () => {
    expect(mergeRefresh(rows(2, 1), null, rows(3, 1), undefined).cursor).toBe(
      null
    )
    expect(mergeRefresh(rows(2, 2), null, rows(3, 2), 2).cursor).toBe(2)
  })

  test("an empty fresh page leaves the list as it was", () => {
    expect(mergeRefresh(rows(2, 1), 1, [], undefined)).toEqual({
      entries: rows(2, 1),
      cursor: 1,
    })
  })
})

describe("chain message", () => {
  test("names the seq, or says the check failed when there is none", () => {
    expect(chainBrokenMessage({ ...chainBroken, ok: false } as never)).toBe(
      "Audit chain broken at entry 1207. Log entries after this point cannot be trusted."
    )
    expect(
      chainBrokenMessage({ ok: false, brokenAtSeq: 0, reason: "head_mismatch" })
    ).toBe("Audit chain failed verification.")
  })
})

describe("loaders", () => {
  test("loadAudit asks for 50 rows and the cursor, GET only, no store", async () => {
    const fetchMock = stub(() =>
      Promise.resolve(Response.json({ entries: [entry(5)], nextBefore: 5 }))
    )
    const result = await loadAudit(signal(), 51)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/gate/audit?limit=50&before=51"
    )
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" })
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined()
    expect(result).toMatchObject({ status: "ready", nextBefore: 5 })
  })

  test("loadChain maps ok, broken, 401, 500, malformed and network failure", async () => {
    stub(() => Promise.resolve(Response.json(chainOk)))
    expect(await loadChain(signal())).toEqual({
      status: "ready",
      chain: chainOk,
    })
    stub(() => Promise.resolve(Response.json(chainBroken)))
    expect(await loadChain(signal())).toEqual({
      status: "ready",
      chain: chainBroken,
    })
    stub(() => Promise.resolve(new Response(null, { status: 401 })))
    expect(await loadChain(signal())).toEqual({ status: "unauthenticated" })
    stub(() => Promise.resolve(new Response(null, { status: 500 })))
    expect(await loadChain(signal())).toEqual({ status: "error" })
    stub(() => Promise.resolve(Response.json({ ok: true })))
    expect(await loadChain(signal())).toEqual({ status: "error" })
    stub(() => Promise.reject(new TypeError("network")))
    expect(await loadChain(signal())).toEqual({ status: "offline" })
  })

  test("loadHistory reads oldest first and treats 404 as no history", async () => {
    const fetchMock = stub(() => Promise.resolve(Response.json(history)))
    expect(await loadHistory(INTENT_ID, signal())).toEqual({
      status: "ready",
      entries: history.entries,
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/gate/approvals/${INTENT_ID}/history`
    )
    stub(() => Promise.resolve(new Response(null, { status: 404 })))
    expect(await loadHistory(INTENT_ID, signal())).toEqual({
      status: "ready",
      entries: [],
    })
  })
})

test("only the owner may open /activity", () => {
  expect(canAccess("owner", "/activity")).toBe(true)
  expect(canAccess("assistant", "/activity")).toBe(false)
})
