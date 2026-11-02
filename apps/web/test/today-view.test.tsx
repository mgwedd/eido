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
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json({ intents: pendingIntents }))
  )
  vi.stubGlobal("fetch", fetchMock)
  await render()
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/gate/approvals")
  const rows = [...container.querySelectorAll("li")].map((li) => li.textContent)
  expect(rows[0]).toContain("Calendar · Send invitation")
  expect(rows[1]).toContain("Email · Send")
  expect(
    container.querySelector("h1")?.nextElementSibling?.textContent
  ).toContain("2 items need you")
})

test("a malformed response is an error, not a list", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ intents: [{ id: 1 }] })))
  )
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn't load what needs you."
  )
})

test("Retry asks the gate again and shows the list", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ intents: pendingIntents }))
  vi.stubGlobal("fetch", fetchMock)
  await render()
  const retry = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Retry"
  )
  expect(retry).toBeDefined()
  await act(async () => {
    retry?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(container.querySelectorAll("li")).toHaveLength(2)
})

test("a 401 sends the user to Unlock, remembering the page", async () => {
  const replace = vi.fn()
  vi.stubGlobal("location", { pathname: "/", search: "?x=1", replace })
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 401 })))
  )
  await render()
  expect(replace).toHaveBeenCalledWith("/unlock?next=%2F%3Fx%3D1&expired=1")
  expect(container.querySelector("[role=alert]")).toBeNull()
})
