// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { CoreApiEntityList, CoreApiObligationList } from "@eido/schemas"
import { LedgerView, type LedgerViewProps } from "../components/ledger-view"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

const NOW = new Date(2026, 9, 18, 12) // Oct 18, 2026

function toUrlString(url: RequestInfo | URL): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.href
  return url.url
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function renderLedger(props: LedgerViewProps = {}) {
  await act(async () => {
    root.render(<LedgerView now={NOW} {...props} />)
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

const sampleObligations: CoreApiObligationList["obligations"] = [
  {
    id: 1,
    action: "Pay property tax",
    party: "City County",
    dueAt: "2026-10-10", // Overdue relative to Oct 18, 2026
    status: "open",
    direction: "owed",
    hasDraftIntent: false,
    updatedAt: "2026-10-01T00:00:00Z",
    entity: { id: UUID_PROP, name: "Property", tag: "property" },
    source: {
      documentId: "a".repeat(64),
      title: "Tax Statement",
      span: { start: 10, end: 50 },
    },
  },
  {
    id: 2,
    action: "Review lease terms",
    party: "Tenant",
    dueAt: "2026-10-25", // Due within 30 days
    status: "open",
    direction: "waiting",
    hasDraftIntent: true,
    updatedAt: "2026-10-15T00:00:00Z",
    entity: { id: UUID_PROP, name: "Property", tag: "property" },
    source: {
      documentId: "b".repeat(64),
      title: "Lease Draft",
      span: { start: 100, end: 150 },
    },
  },
  {
    id: 3,
    action: "Annual physical exam",
    party: "Dr. Smith",
    dueAt: null, // No due date
    status: "done",
    direction: null,
    hasDraftIntent: false,
    updatedAt: "2026-10-16T00:00:00Z",
    entity: { id: UUID_PERS, name: "Personal", tag: "personal" },
    source: {
      documentId: "c".repeat(64),
      span: { start: 0, end: 30 },
    },
  },
]

describe("LedgerView", () => {
  test("renders desktop table with scoped headers, formatted due dates, status chips, and source links", async () => {
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
        if (url.includes("/api/core/obligations")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                obligations: sampleObligations,
                nextOffset: null,
              }),
          })
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      })
    )

    await renderLedger()

    // Header
    const heading = container.querySelector("h1")
    expect(heading?.textContent).toBe("Ledger")

    const repliesLink = container.querySelector('a[href="/ledger/replies"]')
    expect(repliesLink?.textContent).toContain("Replies owed")

    // Scoped table headers at desktop
    const ths = Array.from(container.querySelectorAll("th"))
    expect(ths.map((th) => th.textContent?.trim())).toEqual([
      "Obligation",
      "Entity",
      "Due",
      "Source",
      "Status",
    ])
    for (const th of ths) {
      expect(th.getAttribute("scope")).toBe("col")
    }

    // Row 1: overdue styling and source link
    expect(container.textContent).toContain("Pay property tax")
    expect(container.textContent).toContain("City County")
    expect(container.textContent).toContain("8 days overdue")

    const sourceLink1 = container.querySelector(
      `a[href*="/documents/${"a".repeat(64)}"]`
    )
    expect(sourceLink1).not.toBeNull()
    expect(sourceLink1?.getAttribute("href")).toContain("start=10&end=50")
    expect(sourceLink1?.getAttribute("href")).toContain("from=%2Fledger")
    expect(sourceLink1?.textContent?.trim()).toBe("Tax Statement")

    // Row 2: Draft ready chip
    expect(container.textContent).toContain("Review lease terms")
    expect(container.textContent).toContain("Draft ready")

    // Row 3: Done chip and null due date
    expect(container.textContent).toContain("Annual physical exam")
    expect(container.textContent).toContain("Done")
    expect(container.textContent).toContain("No due date")
  })

  test("renders phone list with 44px min targets and link to Documents", async () => {
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
        if (url.includes("/api/core/obligations")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                obligations: sampleObligations,
                nextOffset: null,
              }),
          })
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      })
    )

    await renderLedger()

    // Documents link on mobile header
    const docsLink = container.querySelector('a[href="/documents"]')
    expect(docsLink).not.toBeNull()
    expect(docsLink?.className).toContain("min-h-[44px]")

    // Phone list items have min-h-[44px]
    const listItems = Array.from(container.querySelectorAll("li"))
    expect(listItems.length).toBe(sampleObligations.length)
    for (const li of listItems) {
      expect(li.className).toContain("min-h-[44px]")
    }
  })

  test("filters by entity and updates URL query", async () => {
    const fetchMock = vi.fn().mockImplementation((req: RequestInfo | URL) => {
      const url = toUrlString(req)
      if (url.includes("/api/core/entities")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ entities: sampleEntities }),
        })
      }
      if (url.includes("/api/core/obligations")) {
        const isProp = url.includes(`entity=${UUID_PROP}`)
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              obligations: isProp
                ? sampleObligations.filter((o) => o.entity.id === UUID_PROP)
                : sampleObligations,
              nextOffset: null,
            }),
        })
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal("fetch", fetchMock)

    await renderLedger()

    const entityGroup = container.querySelector(
      '[role="group"][aria-label="Filter by entity"]'
    )
    expect(entityGroup).not.toBeNull()

    const allBtn = entityGroup?.querySelector('button[aria-pressed="true"]')
    expect(allBtn?.textContent?.trim()).toBe("All")

    // Click Property entity button
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
  })

  test("filters by status and updates URL query", async () => {
    const fetchMock = vi.fn().mockImplementation((req: RequestInfo | URL) => {
      const url = toUrlString(req)
      if (url.includes("/api/core/entities")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ entities: sampleEntities }),
        })
      }
      if (url.includes("/api/core/obligations")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              obligations: sampleObligations.filter((o) => o.status === "open"),
              nextOffset: null,
            }),
        })
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal("fetch", fetchMock)

    await renderLedger()

    const statusGroup = container.querySelector(
      '[role="group"][aria-label="Filter by status"]'
    )
    expect(statusGroup).not.toBeNull()

    const openBtn = Array.from(
      statusGroup?.querySelectorAll("button") ?? []
    ).find((b) => b.textContent?.trim() === "Open")

    await click(openBtn)

    expect(openBtn?.getAttribute("aria-pressed")).toBe("true")
    expect(
      fetchMock.mock.calls.some((c) =>
        toUrlString(c[0] as RequestInfo | URL).includes("status=open")
      )
    ).toBe(true)
  })

  test("renders loading state with accessible announcement", async () => {
    let resolveObligations!: (val: unknown) => void
    const slowPromise = new Promise((resolve) => {
      resolveObligations = resolve
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
        return slowPromise
      })
    )

    await act(async () => {
      root.render(<LedgerView now={NOW} />)
      await flush()
    })

    const loadingStatus = container.querySelector('[role="status"]')
    expect(loadingStatus?.textContent).toBe("Loading ledger obligations…")

    // Finish request
    await act(async () => {
      resolveObligations({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ obligations: [], nextOffset: null }),
      })
      await flush()
    })
  })

  test("renders empty states: empty ledger vs filtered empty", async () => {
    // 1. Empty ledger
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
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ obligations: [], nextOffset: null }),
        })
      })
    )

    await renderLedger({ initialEntity: "all", initialStatus: "all" })
    expect(container.textContent).toContain("No obligations found.")

    // 2. Filtered empty
    act(() => {
      root.unmount()
      root = createRoot(container)
    })
    await renderLedger({ initialEntity: UUID_PROP, initialStatus: "all" })
    expect(container.textContent).toContain(
      "No obligations match the selected filters."
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
            Promise.resolve({
              obligations: sampleObligations,
              nextOffset: null,
            }),
        })
      })
    )

    await renderLedger()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load ledger obligations."
    )

    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry"
    )

    await click(btn)

    expect(container.textContent).toContain("Pay property tax")
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
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({}),
        })
      })
    )

    await renderLedger()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load ledger obligations."
    )
  })

  test("pagination: loads more obligations when nextOffset is present", async () => {
    const page1Obligations = [sampleObligations[0]!]
    const page2Obligations = [sampleObligations[1]!]

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
        if (url.includes("offset=1")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                obligations: page2Obligations,
                nextOffset: null,
              }),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ obligations: page1Obligations, nextOffset: 1 }),
        })
      })
    )

    await renderLedger()

    expect(container.textContent).toContain("Pay property tax")
    expect(container.textContent).not.toContain("Review lease terms")

    const loadMoreBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Load more"
    )

    await click(loadMoreBtn)

    expect(container.textContent).toContain("Pay property tax")
    expect(container.textContent).toContain("Review lease terms")
  })

  describe("opened on one obligation", () => {
    const pageOne = sampleObligations.slice(0, 1)
    const pageTwo = sampleObligations.slice(1)

    function stubPaged(opts: { lookup: CoreApiObligationList["obligations"] }) {
      const urls: string[] = []
      const fetchMock = vi.fn().mockImplementation((req: RequestInfo | URL) => {
        const url = toUrlString(req)
        urls.push(url)
        const body = url.includes("/api/core/entities")
          ? { entities: sampleEntities }
          : new URL(url).searchParams.has("id")
            ? { obligations: opts.lookup, nextOffset: null }
            : url.includes("offset=1")
              ? { obligations: pageTwo, nextOffset: null }
              : { obligations: pageOne, nextOffset: 1 }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        })
      })
      vi.stubGlobal("fetch", fetchMock)
      return urls
    }

    test("loads on to the page holding the obligation, marks its row and scrolls to it", async () => {
      const scrolled: string[] = []
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this.getAttribute("data-obligation-row") ?? "")
      }
      const target = sampleObligations[1]
      stubPaged({ lookup: target ? [target] : [] })

      await renderLedger({ initialObligation: "2" })

      const marked = Array.from(
        container.querySelectorAll('[aria-current="true"]')
      )
      expect(
        marked.map((el) => el.getAttribute("data-obligation-row"))
      ).toEqual(["2", "2"])
      expect(marked[0]?.textContent).toContain("Review lease terms")
      expect(container.querySelector('[role="status"]')).toBeNull()
      expect(scrolled).toEqual(["2", "2"])
      const viewerLink = container.querySelector('a[href*="/documents/"]')
      expect(viewerLink?.getAttribute("href")).toContain(
        "from=%2Fledger%3Fobligation%3D2"
      )
    })

    test("an obligation that does not exist says so and marks no row", async () => {
      stubPaged({ lookup: [] })

      await renderLedger({ initialObligation: "999" })

      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        "That obligation was not found."
      )
      expect(container.querySelector('[aria-current="true"]')).toBeNull()
      expect(container.textContent).toContain("Pay property tax")
    })

    test("a malformed id says so without looking it up", async () => {
      const urls = stubPaged({ lookup: [] })

      await renderLedger({ initialObligation: "abc" })

      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        "That obligation was not found."
      )
      expect(urls.some((u) => /[?&]id=/.test(u))).toBe(false)
    })
  })
})
