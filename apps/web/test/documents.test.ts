// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  formatDocumentDate,
  formatDocumentSource,
  formatIngestedDate,
  formatSourceLabel,
  loadDocumentsList,
} from "../lib/documents"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("documents lib", () => {
  test("formatSourceLabel handles known and unknown sources", () => {
    expect(formatSourceLabel("gmail")).toBe("Gmail")
    expect(formatSourceLabel("proton-mail")).toBe("Proton Mail")
    expect(formatSourceLabel("custom-source")).toBe("custom-source")
  })

  test("formatDocumentDate formats dates as short month and day", () => {
    expect(formatDocumentDate("2026-10-18T10:00:00Z")).toBe("Oct 18")
    expect(formatDocumentDate("2026-01-04")).toBe("Jan 4")
    expect(formatDocumentDate("not-a-date")).toBe("not-a-date")
  })

  test("formatDocumentSource formats provenance distinguishing Files, Drive and Gmail attachment", () => {
    expect(formatDocumentSource("local-folder", "Rental")).toBe("Files/Rental")
    expect(formatDocumentSource("local-folder")).toBe("Files")
    expect(formatDocumentSource("gmail", "Rental", "application/pdf")).toBe(
      "Gmail attachment"
    )
    expect(formatDocumentSource("gmail", "Rental", "message/rfc822")).toBe(
      "Gmail"
    )
    expect(
      formatDocumentSource("proton-mail", "Rental", "application/pdf")
    ).toBe("Proton attachment")
    expect(formatDocumentSource("google-drive")).toBe("Drive")
    expect(formatDocumentSource("unknown")).toBe("unknown")
  })

  test("formatIngestedDate formats valid dates and falls back for invalid", () => {
    expect(formatIngestedDate("2026-10-18T10:00:00Z")).toContain("Oct 18, 2026")
    expect(formatIngestedDate("not-a-date")).toBe("not-a-date")
  })

  test("handles 401 unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 401, ok: false })
    )
    const res = await loadDocumentsList(new AbortController().signal)
    expect(res).toEqual({ status: "unauthenticated" })
  })

  test("handles HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 404, ok: false })
    )
    const res = await loadDocumentsList(new AbortController().signal)
    expect(res).toEqual({ status: "error", message: "HTTP 404" })
  })

  test("handles invalid schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ wrong: true }),
      })
    )
    const res = await loadDocumentsList(new AbortController().signal)
    expect(res.status).toBe("error")
  })

  test("handles fetch rejection and rethrows AbortError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")))
    const res = await loadDocumentsList(new AbortController().signal)
    expect(res).toEqual({ status: "error", message: "fail" })

    const abortErr = new DOMException("aborted", "AbortError")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr))
    await expect(
      loadDocumentsList(new AbortController().signal)
    ).rejects.toThrow("aborted")
  })

  test("sets all query options when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ documents: [], nextOffset: null }),
    })
    vi.stubGlobal("fetch", fetchMock)

    await loadDocumentsList(new AbortController().signal, {
      entity: "ent-2",
      source: "gmail",
      type: "invoice",
      q: "statement",
      limit: 10,
      offset: 20,
    })

    const url = fetchMock.mock.calls[0]?.[0] as string
    expect(url).toContain("entity=ent-2")
    expect(url).toContain("source=gmail")
    expect(url).toContain("type=invoice")
    expect(url).toContain("q=statement")
    expect(url).toContain("limit=10")
    expect(url).toContain("offset=20")
  })
})
