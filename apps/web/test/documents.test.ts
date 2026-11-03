// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  formatDocumentDate,
  formatDocumentSource,
  formatIngestedDate,
  formatSourceLabel,
  isLocalFile,
  loadDocumentsList,
  loadPendingTrashKeys,
  parseFileLocation,
  proposeMoveToTrash,
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

  test("isLocalFile correctly identifies files sources", () => {
    expect(isLocalFile("files")).toBe(true)
    expect(isLocalFile("local-folder")).toBe(true)
    expect(isLocalFile("gmail")).toBe(false)
    expect(isLocalFile("google-drive")).toBe(false)
    expect(isLocalFile("proton-mail")).toBe(false)
  })

  test("parseFileLocation parses JSON sourceRef and falls back to path string", () => {
    expect(
      parseFileLocation("files", JSON.stringify(["docs", "tax/w2.pdf"]))
    ).toEqual({
      root: "docs",
      path: "tax/w2.pdf",
    })
    expect(parseFileLocation("local-folder", "docs/tax/w2.pdf")).toEqual({
      root: "docs",
      path: "tax/w2.pdf",
    })
    expect(parseFileLocation("gmail", "message-123")).toBeNull()
    expect(parseFileLocation("files", "invalid-no-slash")).toBeNull()
  })

  test("proposeMoveToTrash posts file.delete intent to core", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          id: "intent-123",
          tier: "approval",
          state: "pending",
        }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const res = await proposeMoveToTrash("docs", "lease.pdf")
    expect(res).toEqual({ ok: true, intentId: "intent-123" })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/core/intents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          intent: {
            kind: "file.delete",
            args: { root: "docs", path: "lease.pdf" },
          },
          origin: "reactive",
        }),
      })
    )
  })

  test("proposeMoveToTrash handles failure responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 500,
        ok: false,
      })
    )
    const res = await proposeMoveToTrash("docs", "lease.pdf")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.message).toContain("HTTP 500")
    }
  })

  test("loadPendingTrashKeys collects keys from pending file.delete intents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            intents: [
              {
                id: "i-1",
                kind: "file.delete",
                tier: "approval",
                state: "pending",
                origin: "reactive",
                createdAt: "2026-10-18T10:00:00Z",
                title: "Move to Eido Trash: lease.pdf",
                subtitle: "docs/lease.pdf",
              },
              {
                id: "i-2",
                kind: "email.send",
                tier: "approval",
                state: "pending",
                origin: "reactive",
                createdAt: "2026-10-18T10:00:00Z",
              },
            ],
          }),
      })
    )

    const keys = await loadPendingTrashKeys()
    expect(keys.has("docs/lease.pdf")).toBe(true)
    expect(keys.has("lease.pdf")).toBe(true)
  })

  test("proposeMoveToTrash handles forbidden tier and invalid schemas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            id: "i-forbid",
            tier: "forbidden",
            state: "rejected",
          }),
      })
    )
    const res = await proposeMoveToTrash("docs", "lease.pdf")
    expect(res).toEqual({
      ok: false,
      message: "Intent was rejected or forbidden",
    })

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ not: "valid" }),
      })
    )
    const invalidRes = await proposeMoveToTrash("docs", "lease.pdf")
    expect(invalidRes).toEqual({
      ok: false,
      message: "Intent was rejected or forbidden",
    })
  })

  test("proposeMoveToTrash rethrows AbortError and formats non-Error", async () => {
    const abortErr = new DOMException("aborted", "AbortError")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr))
    await expect(proposeMoveToTrash("docs", "lease.pdf")).rejects.toThrow(
      "aborted"
    )

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("string failure"))
    const errRes = await proposeMoveToTrash("docs", "lease.pdf")
    expect(errRes).toEqual({ ok: false, message: "Network error" })
  })

  test("loadPendingTrashKeys handles non-ok, invalid json, and network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    )
    const res1 = await loadPendingTrashKeys()
    expect(res1.size).toBe(0)

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ bad: true }),
      })
    )
    const res2 = await loadPendingTrashKeys()
    expect(res2.size).toBe(0)

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network fail")))
    const res3 = await loadPendingTrashKeys()
    expect(res3.size).toBe(0)

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            intents: [
              {
                id: "i-noslash",
                kind: "file.delete",
                tier: "approval",
                state: "pending",
                origin: "reactive",
                createdAt: "2026-10-18T10:00:00Z",
                subtitle: "singlepath",
              },
              {
                id: "i-notrash",
                kind: "file.delete",
                tier: "approval",
                state: "pending",
                origin: "reactive",
                createdAt: "2026-10-18T10:00:00Z",
                title: "Other title",
              },
            ],
          }),
      })
    )
    const res4 = await loadPendingTrashKeys()
    expect(res4.has("singlepath")).toBe(true)
  })
})
