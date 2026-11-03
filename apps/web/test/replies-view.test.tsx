// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { CoreApiEntityList, CoreApiObligationList } from "@eido/schemas"
import { RepliesView, type RepliesViewProps } from "../components/replies-view"

const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

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
  router.push.mockClear()
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
    /** Answers POST /api/core/replies/draft; absent, the route is not stubbed. */
    draft?: (init: RequestInit | undefined) => Promise<Response>
  } = {}
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = toUrlString(input)
    if (urlStr.includes("/api/core/replies/draft") && options.draft) {
      return options.draft(init)
    }
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
      "Action",
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

  describe("Draft reply", () => {
    const DRAFT_ROUTE = "/api/core/replies/draft"
    const json = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
      )
    const savedBody = (created: boolean) => ({
      intentId: "intent-9",
      tier: "auto",
      state: "approved",
      activityHref: "/activity?intent=intent-9",
      created,
    })
    const requestBody = (init: RequestInit | undefined): string =>
      typeof init?.body === "string" ? init.body : ""
    const draftCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
      fetchMock.mock.calls.filter(([url]) =>
        toUrlString(url).includes(DRAFT_ROUTE)
      )
    const draftButtons = () =>
      Array.from(container.querySelectorAll("button")).filter((b) =>
        /^(Draft reply|Drafting…)$/.test(b.textContent?.trim() ?? "")
      )
    const savedLinks = () =>
      Array.from(container.querySelectorAll("a")).filter(
        (a) => a.textContent?.trim() === "Draft saved"
      )

    test("one click makes one POST for that obligation and shows Draft saved on that row only", async () => {
      const fetchMock = stubFetch({ draft: () => json(201, savedBody(true)) })
      await renderReplies()
      // Two owed rows, each rendered in the desktop table and the phone list.
      expect(draftButtons()).toHaveLength(4)

      await click(draftButtons()[0])

      const calls = draftCalls(fetchMock)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.[1]?.method).toBe("POST")
      expect(JSON.parse(requestBody(calls[0]?.[1]))).toEqual({
        obligationId: 1,
      })
      // Desktop and phone render of the saved row link to the Activity entry.
      expect(savedLinks().map((a) => a.getAttribute("href"))).toEqual([
        "/activity?intent=intent-9",
        "/activity?intent=intent-9",
      ])
      // The other owed row still offers the button.
      expect(draftButtons()).toHaveLength(2)
      // Nothing but the draft route was written to.
      const writes = fetchMock.mock.calls.filter(
        ([, init]) => init?.method === "POST"
      )
      expect(writes).toHaveLength(1)
    })

    test("a second click while pending makes no second request and the button is disabled", async () => {
      let resolve: (r: Response) => void = () => undefined
      const pending = new Promise<Response>((r) => {
        resolve = r
      })
      const fetchMock = stubFetch({ draft: () => pending })
      await renderReplies()

      const first = draftButtons()[0]
      await click(first)
      await click(first)

      expect(draftCalls(fetchMock)).toHaveLength(1)
      const busy = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Drafting…"
      )
      expect(busy?.hasAttribute("disabled")).toBe(true)
      expect(busy?.getAttribute("aria-busy")).toBe("true")

      await act(async () => {
        resolve(
          new Response(JSON.stringify(savedBody(true)), {
            status: 201,
            headers: { "content-type": "application/json" },
          })
        )
        await flush()
      })
      expect(savedLinks()).toHaveLength(2)
    })

    test("a 200 for a thread that already has a draft shows Draft saved", async () => {
      stubFetch({ draft: () => json(200, savedBody(false)) })
      await renderReplies()

      await click(draftButtons()[0])

      expect(savedLinks()[0]?.getAttribute("href")).toBe(
        "/activity?intent=intent-9"
      )
    })

    test("a row the list says has a draft intent shows Draft saved linking to Activity, with no button", async () => {
      const [first, ...rest] = sampleObligations
      if (!first) throw new Error("fixture")
      stubFetch({
        obligations: {
          obligations: [{ ...first, hasDraftIntent: true }, ...rest],
          nextOffset: null,
        },
      })
      await renderReplies()

      expect(savedLinks().map((a) => a.getAttribute("href"))).toEqual([
        "/activity",
        "/activity",
      ])
      expect(draftButtons()).toHaveLength(2)
    })

    test("a failed draft says why, stays retryable, and a retry can save", async () => {
      let answer = () =>
        json(409, { error: { code: "connector_paused", message: "paused" } })
      const fetchMock = stubFetch({ draft: () => answer() })
      await renderReplies()

      await click(draftButtons()[0])

      const alert = container.querySelector('[role="alert"]')
      expect(alert?.textContent).toBe(
        "Mail connector paused. Nothing was drafted. Open Connectors"
      )
      expect(alert?.querySelector("a")?.getAttribute("href")).toBe(
        "/connectors"
      )
      expect(savedLinks()).toHaveLength(0)
      const retry = draftButtons()[0]
      expect(retry?.hasAttribute("disabled")).toBe(false)

      answer = () => json(201, savedBody(true))
      await click(retry)

      expect(draftCalls(fetchMock)).toHaveLength(2)
      expect(savedLinks()).toHaveLength(2)
      expect(container.querySelector('[role="alert"]')).toBeNull()
    })

    test("offline disables every button with a reason and a click makes no request", async () => {
      const fetchMock = stubFetch({ draft: () => json(201, savedBody(true)) })
      await renderReplies({ isOffline: true })

      const buttons = draftButtons()
      expect(buttons).toHaveLength(4)
      expect(buttons.every((b) => b.hasAttribute("disabled"))).toBe(true)
      expect(buttons[0]?.getAttribute("title")).toBe("Unavailable offline")
      await click(buttons[0])
      expect(draftCalls(fetchMock)).toHaveLength(0)
    })

    test("a paused Gmail connector is shown on the page", async () => {
      stubFetch()
      await renderReplies({
        initialConnectors: [
          {
            name: "gmail",
            enabled: false,
            pinnedAt: "2026-01-01T00:00:00Z",
            scopes: [],
            health: "healthy",
            consecutiveFailures: 0,
            manifestHash: "abc",
          },
        ],
      })

      expect(
        Array.from(container.querySelectorAll('[role="status"]')).map((el) =>
          el.textContent?.trim()
        )
      ).toContain("Gmail paused: its threads are not included.")
    })
  })

  describe("keyboard shortcuts", () => {
    const DRAFT_ROUTE = "/api/core/replies/draft"
    const draftResponse = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            intentId: "intent-9",
            tier: "auto",
            state: "approved",
            activityHref: "/activity?intent=intent-9",
            created: true,
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
      )
    const requestBody = (init: RequestInit | undefined): string =>
      typeof init?.body === "string" ? init.body : ""
    const draftCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
      fetchMock.mock.calls.filter(([url]) =>
        toUrlString(url).includes(DRAFT_ROUTE)
      )

    async function press(key: string, target: EventTarget = document.body) {
      await act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
        )
        await flush()
      })
    }
    /** The party names of the rows marked as focused, one per desktop and phone render. */
    const focusedParties = () =>
      Array.from(container.querySelectorAll('[aria-current="true"]')).map(
        (row) => row.textContent ?? ""
      )

    test("j and k move a visible focus between owed rows and stop at the ends", async () => {
      stubFetch()
      await renderReplies()
      expect(focusedParties()).toEqual([])

      await press("j")
      expect(focusedParties().every((t) => t.includes("Tenant, Unit 2"))).toBe(
        true
      )
      expect(focusedParties()).toHaveLength(2)

      await press("j")
      expect(focusedParties().every((t) => t.includes("Accountant"))).toBe(true)

      // Past the last owed row: the Waiting on row is not part of the walk.
      await press("j")
      expect(focusedParties().every((t) => t.includes("Accountant"))).toBe(true)

      await press("k")
      expect(focusedParties().every((t) => t.includes("Tenant, Unit 2"))).toBe(
        true
      )
    })

    test("focus is dropped when the focused row leaves the list", async () => {
      stubFetch()
      await renderReplies()
      await press("j")
      await press("j")
      expect(focusedParties()).toHaveLength(2)

      // Filtering to the entity that has only the first owed row removes the second.
      stubFetch({
        obligations: {
          obligations: sampleObligations.slice(0, 1),
          nextOffset: null,
        },
      })
      await click(
        Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Rental"
        )
      )
      expect(focusedParties()).toEqual([])
    })

    test("Enter opens the focused row's source in the viewer, and does nothing with no focus", async () => {
      stubFetch()
      await renderReplies()

      await press("Enter")
      expect(router.push).not.toHaveBeenCalled()

      await press("j")
      await press("Enter")
      expect(router.push).toHaveBeenCalledTimes(1)
      const url = new URL(String(router.push.mock.calls[0]?.[0]), "http://x")
      expect(url.pathname).toBe(`/documents/${"a".repeat(64)}`)
      expect(url.searchParams.get("start")).toBe("10")
      expect(url.searchParams.get("end")).toBe("50")
      expect(url.searchParams.get("from")).toBe("/ledger/replies")
    })

    test("Enter on a focused link keeps the link's own behaviour", async () => {
      stubFetch()
      await renderReplies()
      await press("j")
      const link = container.querySelector("a[href*='/documents/']")
      await press("Enter", link ?? document.body)
      expect(router.push).not.toHaveBeenCalled()
    })

    test("d drafts the focused row with one POST, shows Draft saved, and a second d adds none", async () => {
      const fetchMock = stubFetch({ draft: draftResponse })
      await renderReplies()

      await press("d")
      expect(draftCalls(fetchMock)).toHaveLength(0)

      await press("j")
      await press("j")
      await press("d")
      await press("d")

      const calls = draftCalls(fetchMock)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.[1]?.method).toBe("POST")
      expect(JSON.parse(requestBody(calls[0]?.[1]))).toEqual({
        obligationId: 2,
      })
      expect(
        Array.from(container.querySelectorAll("a"))
          .filter((a) => a.textContent?.trim() === "Draft saved")
          .map((a) => a.getAttribute("href"))
      ).toEqual(["/activity?intent=intent-9", "/activity?intent=intent-9"])
    })

    test("d while a draft is pending makes no second request", async () => {
      let resolve: (r: Response) => void = () => undefined
      const fetchMock = stubFetch({
        draft: () =>
          new Promise<Response>((r) => {
            resolve = r
          }),
      })
      await renderReplies()
      await press("j")
      await press("d")
      await press("d")
      expect(draftCalls(fetchMock)).toHaveLength(1)
      await act(async () => {
        resolve(await draftResponse())
        await flush()
      })
    })

    test("d shows the same failure as the button and can retry", async () => {
      let answer: () => Promise<Response> = () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: "busy", message: "limit" } }),
            { status: 429, headers: { "content-type": "application/json" } }
          )
        )
      const fetchMock = stubFetch({ draft: () => answer() })
      await renderReplies()
      await press("j")
      await press("d")
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Too many drafts this hour. Try again later."
      )

      answer = draftResponse
      await press("d")
      expect(draftCalls(fetchMock)).toHaveLength(2)
      expect(container.querySelector('[role="alert"]')).toBeNull()
    })

    test("d is inert offline", async () => {
      const fetchMock = stubFetch({ draft: draftResponse })
      await renderReplies({ isOffline: true })
      await press("j")
      await press("d")
      expect(draftCalls(fetchMock)).toHaveLength(0)
    })

    test.each(["j", "k", "d", "Enter"])(
      "%s does nothing while typing in a field",
      async (key) => {
        const fetchMock = stubFetch({ draft: draftResponse })
        await renderReplies()
        await press("j")
        const before = focusedParties()
        const input = document.createElement("input")
        document.body.append(input)
        input.focus()

        await press(key, input)
        input.remove()

        expect(focusedParties()).toEqual(before)
        expect(draftCalls(fetchMock)).toHaveLength(0)
        expect(router.push).not.toHaveBeenCalled()
      }
    )

    test("the keys do nothing while the list is loading or failed", async () => {
      const fetchMock = stubFetch({
        obligationsStatus: 500,
        draft: draftResponse,
      })
      await renderReplies()
      await press("j")
      await press("d")
      expect(draftCalls(fetchMock)).toHaveLength(0)
    })
  })
})
