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

function toUrlString(url: RequestInfo | URL): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.href
  return url.url
}

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

  test("Move to Eido Trash button is disabled for Drive/Gmail with reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL) => {
        const u = toUrlString(url)
        if (u.includes("/api/gate/approvals")) {
          return Promise.resolve(Response.json({ intents: [] }))
        }
        return Promise.resolve(
          Response.json({
            ...SAMPLE_VIEW,
            document: {
              ...SAMPLE_VIEW.document,
              source: "drive",
            },
          })
        )
      })
    )
    const view = await renderViewer({ sha256: SHA256 })
    const trashBtn = Array.from(view.querySelectorAll("button")).find(
      (b) => b.textContent === "Move to Eido Trash"
    )
    expect(trashBtn).toBeDefined()
    expect(trashBtn?.hasAttribute("disabled")).toBe(true)
    expect(trashBtn?.getAttribute("title")).toBe(
      "Only local files can be moved to Eido Trash"
    )

    // Invariant: assert no permanent-delete path exists in UI
    expect(view.textContent?.toLowerCase()).not.toContain("delete permanently")
    expect(view.textContent?.toLowerCase()).not.toContain("permanent delete")
  })

  test("Move to Eido Trash button creates pending intent for local file and updates state", async () => {
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      const u = toUrlString(url)
      if (u.includes("/api/gate/approvals")) {
        return Promise.resolve(Response.json({ intents: [] }))
      }
      if (u.includes("/api/core/intents")) {
        return Promise.resolve(
          Response.json({
            id: "trash-intent-1",
            tier: "approval",
            state: "pending",
          })
        )
      }
      return Promise.resolve(
        Response.json({
          ...SAMPLE_VIEW,
          document: {
            ...SAMPLE_VIEW.document,
            source: "files",
            sourceRef: JSON.stringify(["docs", "Invoice 1042.pdf"]),
          },
        })
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = await renderViewer({ sha256: SHA256 })
    const trashBtn = Array.from(view.querySelectorAll("button")).find(
      (b) => b.textContent === "Move to Eido Trash"
    )
    expect(trashBtn).toBeDefined()
    expect(trashBtn?.hasAttribute("disabled")).toBe(false)

    // Click Move to Eido Trash
    await act(async () => {
      trashBtn?.click()
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/core/intents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          intent: {
            kind: "file.delete",
            args: { root: "docs", path: "Invoice 1042.pdf" },
          },
          origin: "reactive",
        }),
      })
    )

    expect(view.textContent).toContain(
      "Waiting for approval to move to Eido Trash."
    )
  })

  test("Move to Eido Trash displays Waiting for approval when already pending in queue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL) => {
        const u = toUrlString(url)
        if (u.includes("/api/gate/approvals")) {
          return Promise.resolve(
            Response.json({
              intents: [
                {
                  id: "existing-trash-intent",
                  kind: "file.delete",
                  tier: "approval",
                  state: "pending",
                  origin: "reactive",
                  createdAt: "2026-10-18T10:00:00Z",
                  title: "Move to Eido Trash: Invoice 1042.pdf",
                  subtitle: "docs/Invoice 1042.pdf",
                },
              ],
            })
          )
        }
        return Promise.resolve(
          Response.json({
            ...SAMPLE_VIEW,
            document: {
              ...SAMPLE_VIEW.document,
              source: "files",
              sourceRef: JSON.stringify(["docs", "Invoice 1042.pdf"]),
            },
          })
        )
      })
    )

    const view = await renderViewer({ sha256: SHA256 })
    expect(view.textContent).toContain(
      "Waiting for approval to move to Eido Trash."
    )
    // When pending, the button is replaced by status badge
    const trashBtn = Array.from(view.querySelectorAll("button")).find(
      (b) => b.textContent === "Move to Eido Trash"
    )
    expect(trashBtn).toBeUndefined()
  })
})

describe("DocumentViewer type control", () => {
  test("a saved type shows in the viewer marked as set by the owner", async () => {
    const SAVED_SHA = SAMPLE_VIEW.document.sha256
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          return Promise.resolve(
            Response.json({
              sha256: SAVED_SHA,
              type: "Receipt",
              typeSource: "user",
            })
          )
        }
        if (toUrlString(url).includes("/api/gate/approvals")) {
          return Promise.resolve(Response.json({ intents: [] }))
        }
        return Promise.resolve(Response.json(SAMPLE_VIEW))
      })
    )
    const view = await renderViewer({ sha256: SHA256 })
    const valueSlot = () =>
      view.querySelector('[data-slot="select-value"]')?.textContent
    expect(valueSlot()).toBe("invoice")
    expect(view.textContent).not.toContain("Set by you")
    await act(async () => {
      view.querySelector<HTMLElement>('[role="combobox"]')?.click()
      await flush()
    })
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]')
    ).find((o) => o.textContent === "Receipt")
    await act(async () => {
      option?.click()
      await flush()
      await flush()
    })
    expect(valueSlot()).toBe("Receipt")
    expect(view.textContent).toContain("Set by you")
  })
})

describe("DocumentViewer phishing signals", () => {
  const MAIL_VIEW: CoreApiDocumentView = {
    ...SAMPLE_VIEW,
    document: {
      ...SAMPLE_VIEW.document,
      name: "Re: roofing invoice",
      source: "gmail",
      mime: "message/rfc822",
    },
  }

  function stubMail(view: CoreApiDocumentView) {
    const fetcher = vi.fn((url: RequestInfo | URL) =>
      Promise.resolve(
        toUrlString(url).startsWith("/api/core/mail/")
          ? Response.json({ signals: [{ kind: "spf_fail" }] })
          : Response.json(view)
      )
    )
    vi.stubGlobal("fetch", fetcher)
    return fetcher
  }

  test("a mail message opens its signal banner in the detail card", async () => {
    const fetcher = stubMail(MAIL_VIEW)
    const view = await renderViewer({ sha256: SHA256 })
    expect(
      fetcher.mock.calls.some(
        ([url]) => toUrlString(url) === `/api/core/mail/${SHA256}/signals`
      )
    ).toBe(true)
    const chip = view.querySelector("button[aria-expanded]")
    expect(chip?.textContent).toBe("Possible phishing · 1")
    expect(chip?.getAttribute("aria-expanded")).toBe("true")
    expect(
      view.querySelector('[data-slot="alert"]:not([hidden])')?.textContent
    ).toContain("Sender failed SPF")
  })

  test("a file asks for no signals and shows no chip", async () => {
    const fetcher = stubMail(SAMPLE_VIEW)
    const view = await renderViewer({ sha256: SHA256 })
    expect(
      fetcher.mock.calls.some(([url]) =>
        toUrlString(url).startsWith("/api/core/mail/")
      )
    ).toBe(false)
    expect(view.querySelector('[data-slot="mail-signals"]')).toBeNull()
  })
})
