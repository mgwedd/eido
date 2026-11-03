// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { CoreApiDocumentList, CoreApiEntityList } from "@eido/schemas"
import {
  DocumentsView,
  type DocumentsViewProps,
} from "../components/documents-view"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

function toUrlString(url: RequestInfo | URL): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.href
  return url.url
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function renderDocuments(props: DocumentsViewProps = {}) {
  await act(async () => {
    root.render(<DocumentsView {...props} />)
    await flush()
  })
}

async function click(btn: HTMLElement | null | undefined) {
  expect(btn).toBeDefined()
  await act(async () => {
    btn?.click()
    await flush()
  })
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const UUID_PERS = "11111111-1111-1111-1111-111111111111"
const UUID_PROP = "22222222-2222-2222-2222-222222222222"

const sampleEntities: CoreApiEntityList["entities"] = [
  {
    id: UUID_PERS,
    name: "Personal",
    kind: "personal",
    tag: "personal",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: UUID_PROP,
    name: "Property",
    kind: "property",
    tag: "property",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
]

const SHA_1 = "1111111111111111111111111111111111111111111111111111111111111111"
const SHA_2 = "2222222222222222222222222222222222222222222222222222222222222222"

const sampleDocuments: CoreApiDocumentList["documents"] = [
  {
    sha256: SHA_1,
    name: "October Electric Bill.pdf",
    source: "gmail",
    sourceRef: "msg-12345",
    mime: "application/pdf",
    type: "invoice",
    typeSource: "model",
    entity: {
      id: UUID_PROP,
      name: "Property",
      kind: "property",
      tag: "property",
    },
    ingestedAt: "2026-10-18T08:30:00.000Z",
    occurredAt: "2026-10-17T12:00:00.000Z",
    keyFacts: [
      {
        text: "Total $3,250.00",
        href: null,
        isConfirm: false,
      },
    ],
  },
  {
    sha256: SHA_2,
    name: null, // Test fallback display name
    source: "proton-mail",
    sourceRef: "msg-99999",
    mime: "text/plain",
    type: null,
    typeSource: null,
    entity: {
      id: UUID_PERS,
      name: "Personal",
      kind: "personal",
      tag: "personal",
    },
    ingestedAt: "2026-10-15T14:15:00.000Z",
    occurredAt: null,
    keyFacts: [
      {
        text: "1 field to confirm",
        href: "/queue?intent=intent-1",
        isConfirm: true,
      },
    ],
  },
]

describe("DocumentsView", () => {
  test("renders desktop table with scoped headers, formatted dates, and links to viewer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: RequestInfo | URL) => {
        const url = toUrlString(req)
        if (url.includes("/api/core/entities")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ entities: sampleEntities }),
          })
        }
        if (url.includes("/api/core/documents")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                documents: sampleDocuments,
                nextOffset: null,
              }),
          })
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      })
    )

    await renderDocuments()

    // Header
    const heading = container.querySelector("h1")
    expect(heading?.textContent).toBe("Documents")

    // Scoped table headers
    const ths = Array.from(container.querySelectorAll("th"))
    expect(ths.map((th) => th.textContent?.trim())).toEqual([
      "Document",
      "Entity",
      "Type",
      "Source",
      "Date",
      "Key facts",
    ])
    for (const th of ths) {
      expect(th.getAttribute("scope")).toBe("col")
    }

    // Row 1: Document name, entity, type badge, source label & ref, formatted date, key facts
    expect(container.textContent).toContain("October Electric Bill.pdf")
    expect(container.textContent).toContain("Property")
    expect(container.textContent).toContain("invoice")
    expect(container.textContent).toContain("Gmail attachment")
    expect(container.textContent).toContain("msg-12345")
    expect(container.textContent).toContain("Oct 17")
    expect(container.textContent).toContain("Total $3,250.00")

    // Row 1 viewer link
    const link1 = container.querySelector(`a[href*="/documents/${SHA_1}"]`)
    expect(link1).not.toBeNull()
    expect(link1?.getAttribute("href")).toContain("from=%2Fdocuments")

    // Row 2: fallback name using source and short sha, confirm link
    expect(container.textContent).toContain("Proton Mail (22222222)")
    expect(container.textContent).toContain("text/plain")
    expect(container.textContent).toContain("Oct 15")
    expect(container.textContent).toContain("1 field to confirm")

    const confirmLink = container.querySelector(
      'a[href="/queue?intent=intent-1"]'
    )
    expect(confirmLink).not.toBeNull()
    expect(confirmLink?.textContent).toBe("1 field to confirm")
  })

  test("renders phone list with 44px min targets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: RequestInfo | URL) => {
        const url = toUrlString(req)
        if (url.includes("/api/core/entities")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ entities: sampleEntities }),
          })
        }
        if (url.includes("/api/core/documents")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                documents: sampleDocuments,
                nextOffset: null,
              }),
          })
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      })
    )

    await renderDocuments()

    const listItems = Array.from(container.querySelectorAll("li"))
    expect(listItems.length).toBe(sampleDocuments.length)
    for (const li of listItems) {
      expect(li.className).toContain("min-h-[44px]")
    }
  })

  test("filters by entity and source", async () => {
    const fetchMock = vi.fn().mockImplementation((req: RequestInfo | URL) => {
      const url = toUrlString(req)
      if (url.includes("/api/core/entities")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ entities: sampleEntities }),
        })
      }
      if (url.includes("/api/core/documents")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              documents: sampleDocuments,
              nextOffset: null,
            }),
        })
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal("fetch", fetchMock)

    await renderDocuments()

    // Entity filter
    const entityGroup = container.querySelector(
      '[role="group"][aria-label="Filter by entity"]'
    )
    expect(entityGroup).not.toBeNull()
    const propBtn = Array.from(
      entityGroup?.querySelectorAll("button") ?? []
    ).find((b) => b.textContent?.trim() === "Property")

    await click(propBtn)

    expect(propBtn?.getAttribute("aria-pressed")).toBe("true")
    expect(
      fetchMock.mock.calls.some((c) =>
        toUrlString(c[0] as RequestInfo | URL).includes(`entity=${UUID_PROP}`)
      )
    ).toBe(true)

    // Deselect back to all
    const allEntityBtn = Array.from(
      entityGroup?.querySelectorAll("button") ?? []
    ).find((b) => b.textContent?.trim() === "All")
    await click(allEntityBtn)
    expect(allEntityBtn?.getAttribute("aria-pressed")).toBe("true")

    // Source filter
    const sourceGroup = container.querySelector(
      '[role="group"][aria-label="Filter by source"]'
    )
    expect(sourceGroup).not.toBeNull()
    const gmailBtn = Array.from(
      sourceGroup?.querySelectorAll("button") ?? []
    ).find((b) => b.textContent?.trim() === "Gmail")

    await click(gmailBtn)

    expect(gmailBtn?.getAttribute("aria-pressed")).toBe("true")
    expect(
      fetchMock.mock.calls.some((c) =>
        toUrlString(c[0] as RequestInfo | URL).includes("source=gmail")
      )
    ).toBe(true)

    // Deselect source back to all
    const allSourceBtn = Array.from(
      sourceGroup?.querySelectorAll("button") ?? []
    ).find((b) => b.textContent?.trim() === "All")
    await click(allSourceBtn)
    expect(allSourceBtn?.getAttribute("aria-pressed")).toBe("true")
  })

  test("renders loading state with accessible announcement", async () => {
    let resolveDocs!: (val: unknown) => void
    const slowPromise = new Promise((resolve) => {
      resolveDocs = resolve
    })

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: RequestInfo | URL) => {
        const url = toUrlString(req)
        if (url.includes("/api/core/entities")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ entities: [] }),
          })
        }
        if (url.includes("/api/gate/approvals")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ intents: [] }),
          })
        }
        return slowPromise
      })
    )

    await act(async () => {
      root.render(<DocumentsView />)
      await flush()
    })

    const loadingStatus = container.querySelector('[role="status"]')
    expect(loadingStatus?.textContent).toBe("Loading documents…")

    await act(async () => {
      resolveDocs({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ documents: [], nextOffset: null }),
      })
      await flush()
    })
  })

  test("renders empty states: empty documents vs filtered empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: RequestInfo | URL) => {
        const url = toUrlString(req)
        if (url.includes("/api/core/entities")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ entities: [] }),
          })
        }
        if (url.includes("/api/gate/approvals")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ intents: [] }),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ documents: [], nextOffset: null }),
        })
      })
    )

    // 1. Empty documents
    await renderDocuments({ initialEntity: "all", initialSource: "all" })
    expect(container.textContent).toContain("No documents found.")

    // 2. Filtered empty
    act(() => {
      root.unmount()
      root = createRoot(container)
    })
    await renderDocuments({ initialEntity: UUID_PROP, initialSource: "all" })
    expect(container.textContent).toContain(
      "No documents match the selected filters."
    )
  })

  test("renders error state with retry button", async () => {
    let callCount = 0
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: RequestInfo | URL) => {
        const url = toUrlString(req)
        if (url.includes("/api/core/entities")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ entities: [] }),
          })
        }
        if (url.includes("/api/gate/approvals")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ intents: [] }),
          })
        }
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({}),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ documents: sampleDocuments, nextOffset: null }),
        })
      })
    )

    await renderDocuments()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load documents."
    )

    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry"
    )

    await click(retryBtn)

    expect(container.textContent).toContain("October Electric Bill.pdf")
  })

  test("renders unauthenticated error state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: RequestInfo | URL) => {
        const url = toUrlString(req)
        if (url.includes("/api/core/entities")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ entities: [] }),
          })
        }
        if (url.includes("/api/gate/approvals")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ intents: [] }),
          })
        }
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({}),
        })
      })
    )

    await renderDocuments()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load documents."
    )
  })

  test("pagination: loads more documents when nextOffset is present", async () => {
    const page1Docs = [sampleDocuments[0]!]
    const page2Docs = [sampleDocuments[1]!]

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: RequestInfo | URL) => {
        const url = toUrlString(req)
        if (url.includes("/api/core/entities")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ entities: [] }),
          })
        }
        if (url.includes("/api/gate/approvals")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ intents: [] }),
          })
        }
        if (url.includes("offset=1")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({ documents: page2Docs, nextOffset: null }),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ documents: page1Docs, nextOffset: 1 }),
        })
      })
    )

    await renderDocuments()

    expect(container.textContent).toContain("October Electric Bill.pdf")
    expect(container.textContent).not.toContain("Proton Mail (22222222)")

    const loadMoreBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Load more"
    )

    await click(loadMoreBtn)

    expect(container.textContent).toContain("October Electric Bill.pdf")
    expect(container.textContent).toContain("Proton Mail (22222222)")
  })

  test("row shows Waiting for approval to move to Eido Trash when pending in queue", async () => {
    const fileDoc = {
      sha256:
        "3333333333333333333333333333333333333333333333333333333333333333",
      name: "Lease.pdf",
      source: "files",
      sourceRef: JSON.stringify(["docs", "Lease.pdf"]),
      mime: "application/pdf",
      type: "contract",
      typeSource: "model",
      entity: {
        id: UUID_PROP,
        name: "Property",
        kind: "property",
        tag: "property",
      },
      ingestedAt: "2026-10-18T08:30:00.000Z",
      occurredAt: "2026-10-17T12:00:00.000Z",
      keyFacts: [],
    }

    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL) => {
        const u = toUrlString(url)
        if (u.includes("/api/core/entities")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ entities: sampleEntities }),
          })
        }
        if (u.includes("/api/gate/approvals")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                intents: [
                  {
                    id: "trash-1",
                    kind: "file.delete",
                    tier: "approval",
                    state: "pending",
                    origin: "reactive",
                    createdAt: "2026-10-18T10:00:00Z",
                    title: "Move to Eido Trash: Lease.pdf",
                    subtitle: "docs/Lease.pdf",
                  },
                ],
              }),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ documents: [fileDoc], nextOffset: null }),
        })
      })
    )

    await renderDocuments()

    expect(container.textContent).toContain("Lease.pdf")
    expect(container.textContent).toContain(
      "Waiting for approval to move to Eido Trash."
    )
  })
})

describe("DocumentsView type marker", () => {
  test("marks a type set by the owner in the table and the card, and no other", async () => {
    const documents = [
      { ...sampleDocuments[0]!, type: "Quote", typeSource: "user" as const },
      sampleDocuments[1]!,
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: RequestInfo | URL) => {
        const url = toUrlString(req)
        if (url.includes("/api/core/entities")) {
          return Promise.resolve(Response.json({ entities: sampleEntities }))
        }
        return Promise.resolve(Response.json({ documents, nextOffset: null }))
      })
    )
    await renderDocuments()
    const marked = Array.from(container.querySelectorAll("span")).filter(
      (el) => el.textContent === "Set by you"
    )
    // One in the desktop table row and one in the phone card of the same document.
    expect(marked).toHaveLength(2)
    for (const el of marked) {
      expect(el.closest("tr, li, article, div")?.textContent).toContain("Quote")
      expect(el.closest("tr, li, article, div")?.textContent).not.toContain(
        "Proton Mail"
      )
    }
  })
})
