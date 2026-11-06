// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AskView } from "../components/ask-view"
import {
  conversation,
  digestHit,
  hostileHit,
  turnHit,
} from "./fixtures/ask-search"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root
const scrollIntoView = vi.fn()
const searchCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes("/conversations/search"))

beforeEach(() => {
  window.history.replaceState(null, "", "/ask")
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type Routes = {
  search?: () => Response
  conversation?: () => Response
}
function stubApi(routes: Routes = {}) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input)
    if (url.includes("/conversations/search"))
      return Promise.resolve(
        routes.search?.() ??
          Response.json({ hits: [turnHit, digestHit, hostileHit] })
      )
    if (url.includes("/conversations/"))
      return Promise.resolve(
        routes.conversation?.() ?? Response.json(conversation)
      )
    return Promise.reject(new Error(`unexpected ${url}`))
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}
async function flush(action: () => void) {
  await act(async () => {
    action()
    await vi.advanceTimersByTimeAsync(0)
  })
}
async function mount() {
  await flush(() => root.render(<AskView />))
}
async function type(input: HTMLInputElement, value: string) {
  await flush(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
async function debounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
}
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text || b.getAttribute("aria-label") === text
  )
  if (!found) throw new Error(`Button missing: ${text}`)
  return found
}
function searchInput() {
  const input = container.querySelector<HTMLInputElement>(
    'input[type="search"]'
  )
  if (!input) throw new Error("Search input missing")
  return input
}
async function openSearchAndType(query: string) {
  await flush(() => button("Search conversations").click())
  await type(searchInput(), query)
  await debounce()
}

test("the Ask header opens search with the query in the URL and focuses the field", async () => {
  stubApi()
  await mount()
  await flush(() => button("Search conversations").click())
  expect(window.location.pathname + window.location.search).toBe("/ask?search=")
  expect(document.activeElement).toBe(searchInput())
  expect(searchInput().placeholder).toBe("Search past conversations")
})

test("Cmd+K opens search on Ask", async () => {
  stubApi()
  await mount()
  await flush(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        metaKey: true,
        cancelable: true,
      })
    )
  })
  expect(searchInput()).not.toBeNull()
})

test("typing searches after 250 ms with at least 2 characters and keeps the query in the URL", async () => {
  const fetchMock = stubApi()
  await mount()
  await flush(() => button("Search conversations").click())
  await type(searchInput(), "r")
  await debounce()
  expect(searchCalls(fetchMock)).toEqual([])
  await type(searchInput(), "roof")
  await act(async () => {
    await vi.advanceTimersByTimeAsync(249)
  })
  expect(searchCalls(fetchMock)).toEqual([])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(searchCalls(fetchMock)).toEqual([
    "/api/core/conversations/search?q=roof&limit=20&kind=any",
  ])
  expect(window.location.search).toBe("?search=roof")
})

test("results show a kind badge and the snippet with matches in mark; hostile markup stays text", async () => {
  stubApi()
  await mount()
  await openSearchAndType("roof")
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "3 matches"
  )
  const rows = [...container.querySelectorAll("ul a")]
  expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual([
    "Turn",
    "Digest",
    "Turn",
  ])
  expect(
    [...(rows[0]?.querySelectorAll("mark") ?? [])].map((m) => m.textContent)
  ).toEqual(["roof"])
  expect(rows[2]?.textContent).toContain("<img src=x onerror=alert(1)>")
  expect(container.querySelector("img")).toBeNull()
})

test("the kind filter narrows the same query: All, Turns, Digests map to any, raw, digest", async () => {
  const fetchMock = stubApi()
  await mount()
  await openSearchAndType("roof")
  await flush(() => button("Turns").click())
  await flush(() => button("Digests").click())
  expect(searchCalls(fetchMock)).toEqual([
    "/api/core/conversations/search?q=roof&limit=20&kind=any",
    "/api/core/conversations/search?q=roof&limit=20&kind=raw",
    "/api/core/conversations/search?q=roof&limit=20&kind=digest",
  ])
  expect(searchInput().value).toBe("roof")
})

test("no hits says so and Clear search empties the field", async () => {
  stubApi({ search: () => Response.json({ hits: [] }) })
  await mount()
  await openSearchAndType("zebra")
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'No conversations match "zebra".'
  )
  await flush(() => button("Clear search").click())
  expect(searchInput().value).toBe("")
})

test("a failed search shows the error and Retry searches again", async () => {
  let failing = true
  const fetchMock = stubApi({
    search: () =>
      failing
        ? new Response("{}", { status: 500 })
        : Response.json({ hits: [turnHit] }),
  })
  await mount()
  await openSearchAndType("roof")
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Search is not responding. Check the host.Retry"
  )
  failing = false
  await flush(() => button("Retry").click())
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "1 match"
  )
  expect(searchCalls(fetchMock)).toHaveLength(2)
})

test("opening a turn hit loads the conversation and outlines and scrolls to that turn", async () => {
  const fetchMock = stubApi()
  await mount()
  await openSearchAndType("roof")
  const first = container.querySelector<HTMLAnchorElement>("ul a")
  if (!first) throw new Error("no result")
  await flush(() => first.click())
  expect(window.location.search).toBe(
    "?search=roof&conversation=conv-1&turn=turn-3"
  )
  expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
    "/api/core/conversations/conv-1"
  )
  const viewer = container.querySelector('[aria-label="Conversation"]')
  expect(viewer?.querySelector("h2")?.textContent).toBe("Oct 28, 2030")
  expect(viewer?.textContent).toContain("3 turns · read only")
  const target = viewer?.querySelector('[data-target="true"]')
  expect(target?.getAttribute("data-turn-id")).toBe("turn-3")
  expect(viewer?.querySelectorAll('[data-target="true"]')).toHaveLength(1)
  expect(scrollIntoView).toHaveBeenCalledOnce()
  expect(viewer?.textContent).toContain("Digest · covers 2 turns")
  expect(viewer?.textContent).toContain("M1")
  const labels = [...(viewer?.querySelectorAll("button") ?? [])].map(
    (b) => b.textContent
  )
  expect(labels).not.toContain("Send to queue")
  expect(first.getAttribute("aria-current")).toBe("true")
})

test("a digest hit opens at the digest", async () => {
  stubApi()
  await mount()
  await openSearchAndType("roof")
  const second = container.querySelectorAll<HTMLAnchorElement>("ul a")[1]
  if (!second) throw new Error("no result")
  await flush(() => second.click())
  expect(window.location.search).toBe("?search=roof&conversation=conv-2")
  const target = container.querySelector('[data-target="true"]')
  expect(target?.textContent).toContain("Digest · covers 2 turns")
})

test("a missing conversation says it is no longer stored", async () => {
  stubApi({ conversation: () => new Response("{}", { status: 404 }) })
  await mount()
  await openSearchAndType("roof")
  const first = container.querySelector<HTMLAnchorElement>("ul a")
  if (!first) throw new Error("no result")
  await flush(() => first.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "This conversation is no longer stored.Back to results"
  )
})

test("Close search returns to the question box with its text intact and focused", async () => {
  stubApi()
  await mount()
  const question = container.querySelector<HTMLInputElement>("#ask-question")
  if (!question) throw new Error("question box missing")
  await type(question, "half typed question")
  await flush(() => button("Search conversations").click())
  await flush(() => button("Close search").click())
  const back = container.querySelector<HTMLInputElement>("#ask-question")
  expect(back?.value).toBe("half typed question")
  expect(document.activeElement).toBe(back)
  expect(window.location.search).toBe("")
})

test("Esc in the search field closes search", async () => {
  stubApi()
  await mount()
  await flush(() => button("Search conversations").click())
  await flush(() => {
    searchInput().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    )
  })
  expect(container.querySelector('input[type="search"]')).toBeNull()
})

test("Ask a new question clears the question box and leaves search", async () => {
  stubApi()
  await mount()
  const question = container.querySelector<HTMLInputElement>("#ask-question")
  if (!question) throw new Error("question box missing")
  await type(question, "old text")
  await openSearchAndType("roof")
  const first = container.querySelector<HTMLAnchorElement>("ul a")
  if (!first) throw new Error("no result")
  await flush(() => first.click())
  await flush(() => button("Ask a new question").click())
  expect(
    container.querySelector<HTMLInputElement>("#ask-question")?.value
  ).toBe("")
})

test("browser Back from a conversation returns to the results", async () => {
  stubApi()
  await mount()
  await openSearchAndType("roof")
  const first = container.querySelector<HTMLAnchorElement>("ul a")
  if (!first) throw new Error("no result")
  await flush(() => first.click())
  expect(container.querySelector('[aria-label="Conversation"]')).not.toBeNull()
  await flush(() => {
    window.history.replaceState(null, "", "/ask?search=roof")
    window.dispatchEvent(new PopStateEvent("popstate"))
  })
  expect(container.querySelector('[aria-label="Conversation"]')).toBeNull()
  expect(searchInput().value).toBe("roof")
})

test("loading a search URL directly shows its results", async () => {
  window.history.replaceState(null, "", "/ask?search=roof")
  const fetchMock = stubApi()
  await mount()
  expect(searchInput().value).toBe("roof")
  expect(searchCalls(fetchMock)).toEqual([
    "/api/core/conversations/search?q=roof&limit=20&kind=any",
  ])
})
