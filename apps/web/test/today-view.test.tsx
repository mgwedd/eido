// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { TodayView } from "../components/needs-you"
import { pendingIntents } from "./fixtures/today"

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

async function render() {
  await act(async () => {
    root.render(<TodayView />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test("lists pending intents from the gate, oldest first, and counts them in the header", async () => {
  const fetchMock = vi.fn<typeof fetch>((url) => {
    const urlStr = toUrlString(url)
    if (urlStr.includes("/api/gate/approvals")) {
      return Promise.resolve(Response.json({ intents: pendingIntents }))
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })
  vi.stubGlobal("fetch", fetchMock)
  await render()
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/gate/approvals")
  const rows = [
    ...container.querySelectorAll('[aria-labelledby="needs-you-heading"] li'),
  ].map((li) => li.textContent)
  expect(rows[0]).toContain("Calendar · Send invitation")
  expect(rows[1]).toContain("Email · Send")
  expect(
    container.querySelector("h1")?.nextElementSibling?.textContent
  ).toContain("2 items need you")
})

test("a malformed response is an error, not a list", async () => {
  const fetchMock = vi.fn<typeof fetch>((url) => {
    const urlStr = toUrlString(url)
    if (urlStr.includes("/api/gate/approvals")) {
      return Promise.resolve(Response.json({ intents: [{ id: 1 }] }))
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })
  vi.stubGlobal("fetch", fetchMock)
  await render()
  expect(
    container.querySelector(
      '[aria-labelledby="needs-you-heading"] [role="alert"]'
    )?.textContent
  ).toBe("Couldn't load what needs you.")
})

test("Retry asks the gate again and shows the list", async () => {
  const gateMock = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ intents: pendingIntents }))

  const fetchMock = vi.fn<typeof fetch>((url) => {
    const urlStr = toUrlString(url)
    if (urlStr.includes("/api/gate/approvals")) {
      return gateMock()
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })
  vi.stubGlobal("fetch", fetchMock)
  await render()
  const retry = [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[aria-labelledby="needs-you-heading"] button'
    ),
  ].find((b) => b.textContent === "Retry")
  expect(retry).toBeDefined()
  await act(async () => {
    retry?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(gateMock).toHaveBeenCalledTimes(2)
  expect(
    container.querySelectorAll('[aria-labelledby="needs-you-heading"] li')
  ).toHaveLength(2)
})

test("a 401 sends the user to Unlock, remembering the page", async () => {
  const replace = vi.fn()
  vi.stubGlobal("location", { pathname: "/", search: "?x=1", replace })
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 401 }))
    )
  )
  await render()
  expect(replace).toHaveBeenCalledWith("/unlock?next=%2F%3Fx%3D1&expired=1")
  expect(container.querySelector("[role=alert]")).toBeNull()
})

test("renders confirm.field row with title, confidence subtitle, blue Confirm chip and Review link", async () => {
  const confirmIntent = {
    id: "intent-confirm-1",
    kind: "confirm.field",
    tier: "approval",
    state: "pending",
    origin: "proactive",
    createdAt: "2026-10-18T08:00:00.000Z",
    title: "Confirm Total: CHF 1,200.00",
    subtitle: "Extracted from a scan · confidence 0.71",
  } as const
  const fetchMock = vi.fn<typeof fetch>((url) => {
    const urlStr = toUrlString(url)
    if (urlStr.includes("/api/gate/approvals")) {
      return Promise.resolve(Response.json({ intents: [confirmIntent] }))
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })
  vi.stubGlobal("fetch", fetchMock)
  await render()
  const row = container.querySelector(
    '[aria-labelledby="needs-you-heading"] li'
  )
  expect(row).not.toBeNull()
  expect(row?.textContent).toContain("Confirm Total: CHF 1,200.00")
  expect(row?.textContent).toContain("Extracted from a scan · confidence 0.71")
  expect(row?.textContent).toContain("Confirm")
  const reviewLink = row?.querySelector(
    'a[href="/queue?intent=intent-confirm-1"]'
  )
  expect(reviewLink).not.toBeNull()
  expect(reviewLink?.textContent).toContain("Review")
})
