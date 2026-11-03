// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest"
import { loadLedgerObligations } from "../lib/ledger"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("loadLedgerObligations", () => {
  test("handles 401 unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 401, ok: false })
    )
    const res = await loadLedgerObligations(new AbortController().signal)
    expect(res).toEqual({ status: "unauthenticated" })
  })

  test("handles HTTP non-ok error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 500, ok: false })
    )
    const res = await loadLedgerObligations(new AbortController().signal)
    expect(res).toEqual({ status: "error", message: "HTTP 500" })
  })

  test("handles invalid schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ invalid: true }),
      })
    )
    const res = await loadLedgerObligations(new AbortController().signal)
    expect(res.status).toBe("error")
  })

  test("handles fetch rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network failure"))
    )
    const res = await loadLedgerObligations(new AbortController().signal)
    expect(res).toEqual({ status: "error", message: "network failure" })
  })

  test("rethrows AbortError", async () => {
    const abortErr = new DOMException("aborted", "AbortError")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr))
    await expect(
      loadLedgerObligations(new AbortController().signal)
    ).rejects.toThrow("aborted")
  })

  test("includes all query options when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ obligations: [], nextOffset: null }),
    })
    vi.stubGlobal("fetch", fetchMock)

    await loadLedgerObligations(new AbortController().signal, {
      entity: "ent-1",
      status: "open",
      limit: 25,
      offset: 50,
    })

    const url = fetchMock.mock.calls[0]?.[0] as string
    expect(url).toContain("entity=ent-1")
    expect(url).toContain("status=open")
    expect(url).toContain("limit=25")
    expect(url).toContain("offset=50")
  })
})
