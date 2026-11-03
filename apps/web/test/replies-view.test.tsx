// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { CoreApiEntityList, CoreApiObligationList } from "@eido/schemas"
import { RepliesView, type RepliesViewProps } from "../components/replies-view"

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

async function renderReplies(props: RepliesViewProps = {}) {
  await act(async () => {
    root.render(<RepliesView now={NOW} {...props} />)
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
    name: "Rental",
    kind: "property",
    tag: "property",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
]

const sampleObligations: CoreApiObligationList["obligations"] = [
  {
    id: 1,
    action: "Reply to Tenant",
    party: "Tenant, Unit 2",
    dueAt: "2026-10-10", // 8 days overdue relative to Oct 18, 2026
    status: "open",
    direction: "owed",
    hasDraftIntent: false,
    updatedAt: "2026-10-01T00:00:00Z",
    entity: { id: UUID_PROP, name: "Rental", tag: "rental" },
    source: {
      documentId: "a".repeat(64),
      title: "Dishwasher repair: can someone come Tuesday?",
      span: { start: 10, end: 50 },
    },
  },
  {
    id: 2,
    action: "Reply to Accountant: Q3 receipts for Studio LLC",
    party: "Accountant",
    dueAt: "2026-10-25", // Due in 7 days
    status: "open",
    direction: "owed",
    hasDraftIntent: false,
    updatedAt: "2026-10-15T00:00:00Z",
    entity: { id: UUID_PERS, name: "Personal", tag: "personal" },
    source: {
      documentId: "b".repeat(64),
      span: { start: 100, end: 150 },
    },
  },
  {
    id: 3,
    action: "Waiting on Example Roofing Co.: Start date and disposal",
    party: "Example Roofing Co.",
    dueAt: "2026-10-12", // 6 days overdue
    status: "open",
    direction: "waiting",
    hasDraftIntent: false,
    updatedAt: "2026-10-08T00:00:00Z",
    entity: { id: UUID_PROP, name: "Rental", tag: "rental" },
    source: {
      documentId: "c".repeat(64),
      title: "Start date and disposal",
      span: { start: 0, end: 30 },
    },
  },
  {
    id: 4,
    action: "Other non-reply obligation",
    party: "Utility",
    dueAt: "2026-11-01",
    status: "open",
    direction: null,
    hasDraftIntent: false,
    updatedAt: "2026-10-01T00:00:00Z",
    entity: { id: UUID_PERS, name: "Personal", tag: "personal" },
    source: {
      documentId: "d".repeat(64),
      span: { start: 0, end: 10 },
    },
  },
]

function stubFetch(
  options: {
    obligations?: CoreApiObligationList
    entities?: CoreApiEntityList
    obligationsStatus?: number
  } = {}
) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const urlStr = toUrlString(input)
    if (urlStr.includes("/api/core/entities")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(options.entities ?? { entities: sampleEntities }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    }
    if (urlStr.includes("/api/core/obligations")) {
      const status = options.obligationsStatus ?? 200
      if (status !== 200) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "Failed" }), {
            status,
            headers: { "content-type": "application/json" },
          })
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify(
            options.obligations ?? {
              obligations: sampleObligations,
              nextOffset: null,
            }
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })

  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("RepliesView", () => {
  test("renders desktop layout with scoped headers, separated owed and waiting groups, and viewer links", async () => {
    stubFetch()
    await renderReplies()

    // Title and subtitle
    const h1 = container.querySelector("h1")
    expect(h1?.textContent).toBe("Replies owed")
    expect(container.textContent).toContain(
      "Threads waiting on you, and threads you are waiting on."
    )

    // Sub-nav
    const subnavObligations = container.querySelector('a[href="/ledger"]')
    const subnavReplies = container.querySelector('a[href="/ledger/replies"]')
    expect(subnavObligations).toBeDefined()
    expect(subnavReplies?.getAttribute("aria-current")).toBe("page")

    // Scoped table headers on desktop
    const ths = Array.from(container.querySelectorAll("th"))
    const headersText = ths.map((th) => th.textContent?.trim())
    expect(headersText).toEqual([
      "From",
      "About",
      "Entity",
      "Waiting",
      "Who",
      "About",
      "Entity",
      "Since",
    ])
    for (const th of ths) {
      expect(th.getAttribute("scope")).toBe("col")
    }

    // Owed section: overdue row first
    expect(container.textContent).toContain("Tenant, Unit 2")
    expect(container.textContent).toContain(
      "Dishwasher repair: can someone come Tuesday?"
    )
    expect(container.textContent).toContain("8 days overdue")

    // Owed section: future row
    expect(container.textContent).toContain("Accountant")
    expect(container.textContent).toContain("Q3 receipts for Studio LLC")

    // Waiting section
    expect(container.textContent).toContain("Example Roofing Co.")
    expect(container.textContent).toContain("Start date and disposal")
    expect(container.textContent).toContain("6 days overdue")

    // Non-reply obligation is excluded
    expect(container.textContent).not.toContain("Other non-reply obligation")

    // Anchoring message span link in document viewer
    const viewerLink = container.querySelector(
      `a[href*="/documents/${"a".repeat(64)}"]`
    )
    expect(viewerLink).toBeDefined()
    const href = viewerLink?.getAttribute("href") ?? ""
    expect(href).toContain("start=10")
    expect(href).toContain("end=50")
    expect(href).toContain("from=%2Fledger%2Freplies")
  })

  test("renders phone list with 44px min touch targets and waiting chip", async () => {
    stubFetch()
    await renderReplies()

    const phoneLists = container.querySelectorAll("ul[role='list']")
    expect(phoneLists.length).toBe(2)

    const listItems = container.querySelectorAll("ul[role='list'] li")
    expect(listItems.length).toBe(3) // 2 owed + 1 waiting
    for (const item of Array.from(listItems)) {
      expect(item.className).toContain("min-h-[44px]")
    }

    // Waiting badge on waiting row
    expect(container.textContent).toContain("Waiting")
  })

  test("filters by entity and updates URL query", async () => {
    const fetchMock = stubFetch()
    const pushStateSpy = vi.spyOn(window.history, "pushState")

    await renderReplies()

    const rentalBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Rental"
    )
    await click(rentalBtn)

    expect(pushStateSpy).toHaveBeenCalledWith(
      null,
      "",
      `/ledger/replies?entity=${encodeURIComponent(UUID_PROP)}`
    )

    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
    expect(lastCall).toBeDefined()
    const url = toUrlString(lastCall![0])
    expect(url).toContain(`entity=${UUID_PROP}`)

    // Click "All" to reset filter
    const allBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "All"
    )
    await click(allBtn)
    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/ledger/replies")
  })

  test("handles rows with null party, null dueAt, and asymmetric empty groups", async () => {
    const asymmetricObligations: CoreApiObligationList["obligations"] = [
      {
        id: 10,
        action: "Reply without due date",
        party: null,
        dueAt: null,
        status: "open",
        direction: "owed",
        hasDraftIntent: false,
        updatedAt: null,
        entity: { id: UUID_PROP, name: "Rental", tag: "rental" },
        source: {
          documentId: "e".repeat(64),
          span: { start: 0, end: 10 },
        },
      },
    ]

    stubFetch({
      obligations: { obligations: asymmetricObligations, nextOffset: null },
    })

    await renderReplies()

    // Owed has item with Unknown party and No due date
    expect(container.textContent).toContain("Unknown")
    expect(container.textContent).toContain("Reply without due date")
    expect(container.textContent).toContain("No due date")

    // Waiting is empty
    expect(container.textContent).toContain("Nothing waiting on others.")

    // Now test waiting only
    const waitingOnlyObligations: CoreApiObligationList["obligations"] = [
      {
        id: 20,
        action: "Waiting on Contractor",
        party: null,
        dueAt: null,
        status: "open",
        direction: "waiting",
        hasDraftIntent: false,
        updatedAt: null,
        entity: { id: UUID_PROP, name: "Rental", tag: "rental" },
        source: {
          documentId: "f".repeat(64),
          span: { start: 0, end: 10 },
        },
      },
    ]

    act(() => root.unmount())
    root = createRoot(container)

    stubFetch({
      obligations: { obligations: waitingOnlyObligations, nextOffset: null },
    })

    await renderReplies()

    // Owed is empty
    expect(container.textContent).toContain("No replies owed.")
    // Waiting has item
    expect(container.textContent).toContain("Waiting on Contractor")
  })

  test("renders empty states: empty vs filtered empty", async () => {
    stubFetch({
      obligations: { obligations: [], nextOffset: null },
    })

    await renderReplies()
    expect(container.textContent).toContain("No replies owed.")
    expect(container.textContent).toContain("Nothing waiting on others.")

    // Unmount and remount with entity filter
    act(() => root.unmount())
    root = createRoot(container)

    await renderReplies({ initialEntity: UUID_PROP })
    expect(container.textContent).toContain("No replies owed for this entity.")
    expect(container.textContent).toContain(
      "Nothing waiting on others for this entity."
    )
  })

  test("renders loading state with accessible announcement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    )

    await act(async () => {
      root.render(<RepliesView now={NOW} />)
      await flush()
    })

    const statusEl = container.querySelector('[role="status"]')
    expect(statusEl?.textContent).toContain("Loading replies owed…")
  })

  test("renders error state with retry button", async () => {
    let fail = true
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const urlStr = toUrlString(input)
        if (urlStr.includes("/api/core/entities")) {
          return Promise.resolve(
            new Response(JSON.stringify({ entities: sampleEntities }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        }
        if (urlStr.includes("/api/core/obligations")) {
          if (fail) {
            return Promise.resolve(
              new Response(JSON.stringify({ error: "Server error" }), {
                status: 500,
              })
            )
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                obligations: sampleObligations,
                nextOffset: null,
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          )
        }
        return Promise.resolve(new Response(null, { status: 404 }))
      })
    )

    await renderReplies()

    expect(container.textContent).toContain("Couldn't load replies owed.")
    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry"
    )
    expect(retryBtn).toBeDefined()

    fail = false
    await click(retryBtn)

    expect(container.textContent).not.toContain("Couldn't load replies owed.")
    expect(container.textContent).toContain("Tenant, Unit 2")
  })

  test("renders unauthenticated error state", async () => {
    stubFetch({ obligationsStatus: 401 })
    await renderReplies()

    expect(container.textContent).toContain("Sign in required to view replies.")
  })
})
