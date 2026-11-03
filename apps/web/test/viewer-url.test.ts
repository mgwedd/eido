import { describe, expect, test } from "vitest"
import { buildViewerUrl } from "../lib/viewer-url"

describe("buildViewerUrl", () => {
  const DOC_ID =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

  test("generates bare document URL when no span or from is provided", () => {
    expect(buildViewerUrl(DOC_ID)).toBe(`/documents/${DOC_ID}`)
    expect(buildViewerUrl(DOC_ID, null)).toBe(`/documents/${DOC_ID}`)
  })

  test("encodes character start and end span", () => {
    const url = buildViewerUrl(DOC_ID, { start: 120, end: 180 })
    expect(url).toBe(`/documents/${DOC_ID}?start=120&end=180`)
  })

  test("encodes page and line span if present", () => {
    const url = buildViewerUrl(DOC_ID, {
      start: 50,
      end: 100,
      page: 2,
      line: 14,
    })
    expect(url).toBe(`/documents/${DOC_ID}?start=50&end=100&page=2&line=14`)
  })

  test("handles individual span fields", () => {
    expect(buildViewerUrl(DOC_ID, { page: 3 })).toBe(
      `/documents/${DOC_ID}?page=3`
    )
    expect(buildViewerUrl(DOC_ID, { line: 10 })).toBe(
      `/documents/${DOC_ID}?line=10`
    )
    expect(buildViewerUrl(DOC_ID, { start: 15 })).toBe(
      `/documents/${DOC_ID}?start=15`
    )
    expect(buildViewerUrl(DOC_ID, { end: 25 })).toBe(
      `/documents/${DOC_ID}?end=25`
    )
  })

  test("encodes from parameter so viewer Back button returns to caller", () => {
    const url = buildViewerUrl(
      DOC_ID,
      { start: 0, end: 10 },
      "/ledger?entity=personal&status=open"
    )
    expect(url).toBe(
      `/documents/${DOC_ID}?start=0&end=10&from=%2Fledger%3Fentity%3Dpersonal%26status%3Dopen`
    )
  })

  test("encodes from parameter without span", () => {
    const url = buildViewerUrl(DOC_ID, null, "/documents?source=gmail")
    expect(url).toBe(`/documents/${DOC_ID}?from=%2Fdocuments%3Fsource%3Dgmail`)
  })
})
