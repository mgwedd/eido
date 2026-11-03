// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { CoreApiDocumentView } from "@eido/schemas"
import {
  DocumentViewer,
  validateFromParam,
} from "../components/document-viewer"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string
    children: React.ReactNode
    className?: string
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

const SHA256 = "a".repeat(64)
const RELATED_SHA256 = "b".repeat(64)

const SAMPLE_VIEW: CoreApiDocumentView = {
  document: {
    sha256: SHA256,
    name: "Invoice 1042.pdf",
    source: "drive",
    sourceRef: "drive:1042",
    mime: "application/pdf",
    type: "invoice",
    typeSource: "model",
    entity: {
      id: "ent-1",
      kind: "company",
      name: "Acme Corp",
      tag: "acme",
    },
    ingestedAt: "2026-03-01T12:00:00.000Z",
    occurredAt: null,
    keyFacts: [],
  },
  lines: [
    { n: 1, start: 0, text: "Invoice #1042" },
    { n: 2, start: 14, text: "Total Amount: CHF 1,200.00 due immediately" },
    { n: 3, start: 57, text: "Thank you for your business" },
  ],
  highlight: {
    start: 28,
    end: 40,
    text: "CHF 1,200.00",
    fromLine: 2,
    toLine: 2,
  },
  extractions: [
    {
      id: 1,
      createdAt: "2026-03-01T12:00:00.000Z",
      confirmedAt: null,
      fields: [
        {
          field: "party",
          raw: "Example Roofing Co.",
          value: null,
          span: { start: 0, end: 19 },
          line: 1,
          confidence: 0.95,
          verified: true,
        },
        {
          field: "amount",
          raw: "$3,250.00",
          value: { amount_minor: 325000, currency: "USD" },
          span: { start: 28, end: 37 },
          line: 9,
          confidence: 0.98,
          verified: true,
        },
      ],
    },
  ],
  linked: {
    obligations: [
      {
        id: 10,
        action: "Pay invoice",
        party: "Utility Supplier",
        dueAt: "2026-03-15",
        status: "open",
      },
    ],
    documents: [
      {
        sha256: RELATED_SHA256,
        name: "Quote 980.pdf",
        source: "email",
      },
    ],
  },
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function renderViewer(
  props: Parameters<typeof DocumentViewer>[0]
): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(<DocumentViewer {...props} />)
    await flush()
    await flush()
  })
  return container
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("validateFromParam", () => {
  test("defaults to /documents when undefined or empty", () => {
    expect(validateFromParam(undefined)).toBe("/documents")
    expect(validateFromParam("")).toBe("/documents")
  })

  test("rejects protocol-relative and scheme-containing URLs to prevent open redirect", () => {
    expect(validateFromParam("//evil.com")).toBe("/documents")
    expect(validateFromParam("http://evil.com")).toBe("/documents")
    expect(validateFromParam("javascript:alert(1)")).toBe("/documents")
    expect(validateFromParam("/\\evil.com")).toBe("/documents")
    expect(validateFromParam("/foo:bar")).toBe("/documents")
  })

  test("accepts valid relative internal paths with search queries", () => {
    expect(validateFromParam("/queue?intent=abc-123")).toBe(
      "/queue?intent=abc-123"
    )
    expect(validateFromParam("/documents")).toBe("/documents")
    expect(validateFromParam("/ask?q=test")).toBe("/ask?q=test")
  })
})

describe("DocumentViewer states", () => {
  test("displays loading skeleton initially while request is pending", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    )
    const container = document.createElement("div")
    document.body.appendChild(container)
    act(() => {
      createRoot(container).render(<DocumentViewer sha256={SHA256} />)
    })
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(
      0
    )
  })

  test("renders 404 Document not found when document is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 })))
    )
    const view = await renderViewer({
      sha256: SHA256,
      from: "/queue?intent=1",
    })
    expect(view.textContent).toContain("Document not found")
    expect(view.textContent).toContain(SHA256)
    const backLink = view.querySelector("a")
    expect(backLink?.getAttribute("href")).toBe("/queue?intent=1")
    expect(backLink?.textContent).toContain("Back")
  })

  test("renders error state when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Network disconnect")))
    )
    const view = await renderViewer({ sha256: SHA256 })
    expect(view.textContent).toContain("Error loading document")
    expect(view.textContent).toContain("Could not load document")
  })

  test("renders span not found banner when 400 is returned for span", async () => {
    let callCount = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(new Response(null, { status: 400 }))
        }
        return Promise.resolve(
          Response.json({
            ...SAMPLE_VIEW,
            highlight: null,
          })
        )
      })
    )
    const view = await renderViewer({
      sha256: SHA256,
      start: 9999,
      end: 10000,
    })
    expect(view.textContent).toContain("Span not found in this document")
    expect(view.textContent).toContain("Invoice #1042")
  })

  test("renders document with highlighted mark and linked metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(SAMPLE_VIEW)))
    )
    const view = await renderViewer({
      sha256: SHA256,
      start: 28,
      end: 40,
      from: "/queue?intent=intent-1",
    })

    // Header & metadata
    expect(view.textContent).toContain("Invoice 1042.pdf")
    expect(view.textContent).toContain("drive")
    expect(view.textContent).toContain("Acme Corp (acme)")
    expect(view.textContent).toContain(SHA256.slice(0, 12))

    // Download blob link
    const blobLink = view.querySelector(
      `a[href="/api/core/documents/${SHA256}/blob"]`
    )
    expect(blobLink).not.toBeNull()
    expect(blobLink?.getAttribute("download")).toBe("")

    // Passage highlight mark
    const mark = view.querySelector('mark[role="mark"]')
    expect(mark).not.toBeNull()
    expect(mark?.textContent).toContain("Referenced passage")
    expect(mark?.textContent).toContain("CHF 1,200.00")

    // Linked obligations
    expect(view.textContent).toContain("Pay invoice")
    expect(view.textContent).toContain("Utility Supplier")
    expect(view.textContent).toContain("Due 2026-03-15")

    // Linked documents
    expect(view.textContent).toContain("Quote 980.pdf")
    const quoteLink = view.querySelector(`a[href*="${RELATED_SHA256}"]`)
    expect(quoteLink).not.toBeNull()

    // Extracted panel
    expect(view.textContent).toContain("Extracted")
    expect(view.textContent).toContain("Vendor")
    expect(view.textContent).toContain("Example Roofing Co.")
    expect(view.textContent).toContain("Total")
    expect(view.textContent).toContain("$3,250.00")
    expect(view.textContent).toContain("line 9")
    expect(view.textContent).toContain("verified")
    expect(view.textContent).toContain("Entity")
    expect(view.textContent).toContain("Acme Corp")
  })

  test("renders extracted panel with unverified field and date formatting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            ...SAMPLE_VIEW,
            extractions: [
              {
                id: 2,
                createdAt: "2026-03-01T12:00:00.000Z",
                confirmedAt: null,
                fields: [
                  {
                    field: "due_date",
                    raw: "2026-11-03",
                    value: "2026-11-03",
                    span: { start: 0, end: 10 },
                    line: 3,
                    confidence: 0.3,
                    verified: false,
                  },
                ],
              },
            ],
          })
        )
      )
    )
    const view = await renderViewer({ sha256: SHA256 })
    expect(view.textContent).toContain("Due date")
    expect(view.textContent).toContain("Nov 3, 2026")
    expect(view.textContent).toContain("line 3")
    expect(view.textContent).toContain("unverified")
  })

  test("renders empty extracted panel when extractions are empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            ...SAMPLE_VIEW,
            extractions: [],
          })
        )
      )
    )
    const view = await renderViewer({ sha256: SHA256 })
    expect(view.textContent).toContain("No extracted fields.")
  })

  test("renders extracted panel with null line, action field and reference field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            ...SAMPLE_VIEW,
            extractions: [
              {
                id: 3,
                createdAt: "2026-03-01T12:00:00.000Z",
                confirmedAt: null,
                fields: [
                  {
                    field: "action",
                    raw: "Pay water bill",
                    value: null,
                    span: { start: 0, end: 14 },
                    line: null,
                    confidence: 0.8,
                    verified: true,
                  },
                  {
                    field: "reference_number",
                    raw: "REF-9999",
                    value: "REF-9999",
                    span: { start: 15, end: 23 },
                    line: null,
                    confidence: 0.9,
                    verified: false,
                  },
                ],
              },
            ],
          })
        )
      )
    )
    const view = await renderViewer({ sha256: SHA256 })
    expect(view.textContent).toContain("Action")
    expect(view.textContent).toContain("Pay water bill")
    expect(view.textContent).toContain("Reference")
    expect(view.textContent).toContain("REF-9999")
  })

  test("renders error when core answers non-ok status like 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 })))
    )
    const view = await renderViewer({ sha256: SHA256 })
    expect(view.textContent).toContain("Error loading document")
    expect(view.textContent).toContain("Core answered 500")
  })

  test("renders error when json is malformed against schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ malformed: true })))
    )
    const view = await renderViewer({ sha256: SHA256 })
    expect(view.textContent).toContain("Error loading document")
    expect(view.textContent).toContain("Malformed document view")
  })

  test("handles 400 with fallback failure", async () => {
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call++
        if (call === 1)
          return Promise.resolve(new Response(null, { status: 400 }))
        return Promise.resolve(new Response(null, { status: 404 }))
      })
    )
    const view = await renderViewer({ sha256: SHA256, start: 10, end: 20 })
    expect(view.textContent).toContain("Document not found")
  })

  test("handles 400 with malformed fallback", async () => {
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call++
        if (call === 1)
          return Promise.resolve(new Response(null, { status: 400 }))
        return Promise.resolve(Response.json({ bad: true }))
      })
    )
    const view = await renderViewer({ sha256: SHA256, start: 10, end: 20 })
    expect(view.textContent).toContain("Malformed document view")
  })

  test("renders document with null name, empty linked docs and null party/dueAt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            ...SAMPLE_VIEW,
            document: {
              ...SAMPLE_VIEW.document,
              name: null,
            },
            highlight: null,
            linked: {
              obligations: [
                {
                  id: 99,
                  action: "Review contract",
                  party: null,
                  dueAt: null,
                  status: "pending",
                },
              ],
              documents: [],
            },
          })
        )
      )
    )
    const view = await renderViewer({ sha256: SHA256 })
    expect(view.textContent).toContain("drive · aaaaaaaaaaaa")
    expect(view.textContent).toContain("Review contract")
    expect(view.textContent).toContain("No related documents")
  })

  test("renders binary file placeholder when lines array is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            ...SAMPLE_VIEW,
            lines: [],
            highlight: null,
          })
        )
      )
    )
    const view = await renderViewer({ sha256: SHA256 })
    expect(view.textContent).toContain("Text unavailable for this file")
    expect(view.textContent).toContain("Binary or unsupported format")
    expect(view.textContent).toContain("Invoice 1042.pdf")
  })
})
