// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  clearCachedTransactions,
  formatAmount,
  formatPostedDate,
  formatStoredTimestamp,
  linkedObligationUrl,
  loadCachedTransactions,
  loadTransactions,
  saveCachedTransactions,
  summarizeTransactions,
  TRANSACTIONS_CACHE_KEY,
  transactionsPageUrl,
} from "../lib/transactions"
import { groceries, lastYear, NOW, page, rent } from "./fixtures/transactions"

beforeEach(() => {
  clearCachedTransactions()
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearCachedTransactions()
})

const signal = new AbortController().signal

function stub(response: { ok: boolean; status: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

describe("loadTransactions", () => {
  test("sends only the filters that are set and returns the parsed page", async () => {
    const fn = stub({ ok: true, status: 200, body: page([groceries]) })
    const res = await loadTransactions(signal, {
      entity: "e1",
      account: "all",
      limit: 50,
      offset: 50,
    })
    const url = new URL(String(fn.mock.calls[0]?.[0]))
    expect(url.pathname).toBe("/api/core/transactions")
    expect(url.search).toBe("?entity=e1&limit=50&offset=50")
    expect(res).toEqual({ status: "ok", data: page([groceries]) })
  })

  test("a 401 is unauthenticated", async () => {
    stub({ ok: false, status: 401 })
    expect(await loadTransactions(signal)).toEqual({
      status: "unauthenticated",
    })
  })

  test("another failing status is an error", async () => {
    stub({ ok: false, status: 500 })
    expect(await loadTransactions(signal)).toEqual({
      status: "error",
      message: "HTTP 500",
    })
  })

  test("a body that fails the schema is an error", async () => {
    stub({ ok: true, status: 200, body: { transactions: [{ id: "x" }] } })
    const res = await loadTransactions(signal)
    expect(res.status).toBe("error")
  })

  test("a network failure is offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")))
    expect(await loadTransactions(signal)).toEqual({ status: "offline" })
  })

  test("navigator.onLine false reports offline", async () => {
    vi.stubGlobal("navigator", { onLine: false })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network failure"))
    )
    expect(await loadTransactions(signal)).toEqual({ status: "offline" })
  })

  test("other runtime errors are reported as error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("custom boom")))
    expect(await loadTransactions(signal)).toEqual({
      status: "error",
      message: "custom boom",
    })
  })

  test("an abort is rethrown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"))
    )
    await expect(loadTransactions(signal)).rejects.toThrow("aborted")
  })

  test("saves successful unfiltered load to cache", async () => {
    stub({ ok: true, status: 200, body: page([groceries]) })
    const res = await loadTransactions(signal)
    expect(res).toEqual({ status: "ok", data: page([groceries]) })
    expect(loadCachedTransactions()?.data).toEqual(page([groceries]))
  })
})

describe("linkedObligationUrl", () => {
  test("opens the ledger on the obligation id", () => {
    expect(linkedObligationUrl(42)).toBe("/ledger?obligation=42")
  })
})

describe("transactionsPageUrl", () => {
  test("omits unset filters", () => {
    expect(transactionsPageUrl("all", "all")).toBe("/ledger/transactions")
    expect(transactionsPageUrl("e1", "all")).toBe(
      "/ledger/transactions?entity=e1"
    )
    expect(transactionsPageUrl("e1", "a1")).toBe(
      "/ledger/transactions?entity=e1&account=a1"
    )
  })
})

describe("formatPostedDate", () => {
  test("drops the year in the current year and keeps it otherwise", () => {
    expect(formatPostedDate("2026-10-17T00:00:00.000Z", NOW)).toBe("Oct 17")
    expect(formatPostedDate("2025-12-30T00:00:00.000Z", NOW)).toBe(
      "Dec 30, 2025"
    )
  })
  test("returns an unparseable value as written", () => {
    expect(formatPostedDate("not a date", NOW)).toBe("not a date")
  })
})

describe("formatAmount", () => {
  test("shows the sign in text", () => {
    expect(formatAmount(-8412, "USD")).toBe("−$84.12")
    expect(formatAmount(200000, "USD")).toBe("+$2,000.00")
    expect(formatAmount(0, "USD")).toBe("$0.00")
  })
  test("falls back for a currency the runtime does not know", () => {
    expect(formatAmount(-500, "??")).toBe("−5.00 ??")
  })
})

describe("summarizeTransactions", () => {
  test("states the date range and count of the rows shown", () => {
    expect(summarizeTransactions([groceries, rent], NOW)).toBe(
      "Oct 1 – Oct 17 · 2 transactions"
    )
  })
  test("a single day names it once, singular count", () => {
    expect(summarizeTransactions([groceries], NOW)).toBe(
      "Oct 17 · 1 transaction"
    )
  })
  test("years show when the range crosses them", () => {
    expect(summarizeTransactions([groceries, lastYear], NOW)).toBe(
      "Dec 30, 2025 – Oct 17 · 2 transactions"
    )
  })
  test("no rows gives the count alone", () => {
    expect(summarizeTransactions([], NOW)).toBe("0 transactions")
  })
})

describe("cache helpers", () => {
  beforeEach(() => {
    clearCachedTransactions()
  })

  test("saveCachedTransactions and loadCachedTransactions round trip", () => {
    const data = page([groceries])
    const now = new Date("2026-10-17T12:00:00.000Z")
    saveCachedTransactions(data, now)

    const loaded = loadCachedTransactions()
    expect(loaded).toEqual({
      storedAt: "2026-10-17T12:00:00.000Z",
      data,
    })
  })

  test("loadCachedTransactions returns null when nothing is cached", () => {
    expect(loadCachedTransactions()).toBeNull()
  })

  test("loadCachedTransactions returns null on corrupted JSON", () => {
    window.localStorage.setItem(TRANSACTIONS_CACHE_KEY, "not json")
    expect(loadCachedTransactions()).toBeNull()
  })

  test("loadCachedTransactions returns null when payload fails schema validation", () => {
    window.localStorage.setItem(
      TRANSACTIONS_CACHE_KEY,
      JSON.stringify({
        storedAt: "2026-10-17T00:00:00.000Z",
        data: { invalid: true },
      })
    )
    expect(loadCachedTransactions()).toBeNull()
  })

  test("clearCachedTransactions empties the store", () => {
    saveCachedTransactions(page([groceries]))
    expect(loadCachedTransactions()).not.toBeNull()
    clearCachedTransactions()
    expect(loadCachedTransactions()).toBeNull()
  })
})

describe("formatStoredTimestamp", () => {
  test("formats valid ISO timestamp", () => {
    const formatted = formatStoredTimestamp("2026-10-17T12:00:00.000Z")
    expect(formatted).toBeTruthy()
    expect(formatted).not.toBe("2026-10-17T12:00:00.000Z")
  })

  test("returns invalid input as-is", () => {
    expect(formatStoredTimestamp("not-a-date")).toBe("not-a-date")
  })
})
