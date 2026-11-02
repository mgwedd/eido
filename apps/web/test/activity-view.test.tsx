// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { ActivityView } from "../components/activity-view"
import {
  INTENT_ID,
  alertRow,
  autoRow,
  chainBroken,
  chainOk,
  history,
  intentRow,
  refusedRow,
  rows,
} from "./fixtures/activity"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const urlOf = (input: Parameters<typeof fetch>[0]) =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url

type Handler = (url: string) => Response | Promise<Response> | "network"
function serve(handler: Handler) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const out = handler(urlOf(input))
    return out === "network"
      ? Promise.reject(new TypeError("network"))
      : Promise.resolve(out)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}
const settle = () =>
  act(async () => void (await new Promise((r) => setTimeout(r, 0))))
let renders = 0
async function render(intentId?: string) {
  renders += 1
  await act(async () => {
    root.render(<ActivityView key={renders} intentId={intentId} />)
    await new Promise((r) => setTimeout(r, 0))
  })
}
const click = async (label: string) => {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label)
  )
  expect(button, label).toBeDefined()
  await act(async () => {
    button!.click()
    await new Promise((r) => setTimeout(r, 0))
  })
}
const page = (entries: unknown[], nextBefore?: number) =>
  Response.json({ entries, ...(nextBefore ? { nextBefore } : {}) })
const text = () => container.textContent ?? ""
const seqs = () => [...container.querySelectorAll("li time")].length

test("shows the verified banner with the count and rows newest first with real day headings", async () => {
  serve((url) =>
    url.includes("/audit/chain")
      ? Response.json(chainOk)
      : page([intentRow, alertRow, refusedRow, autoRow])
  )
  await render()
  expect(container.querySelector("h1")?.textContent).toBe("Activity")
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Audit chain verified · 1286 entries"
  )
  expect(container.querySelectorAll("section h2").length).toBe(1)
  const actions = [...container.querySelectorAll("li")].map(
    (li) => li.dataset["kind"]
  )
  expect(actions).toEqual(["normal", "alert", "refused", "normal"])
  expect(text()).toContain("Alert")
  expect(text()).toContain("Refused")
  expect(text()).toContain("c41a7e09")
  expect(text()).not.toContain("c41a7e09c41a")
  for (const label of ["you", "auto"]) expect(text()).toContain(label)
  expect(container.textContent).not.toMatch(/undo/i)
  const link = container.querySelector(
    `a[href="/activity?intent=${INTENT_ID}"]`
  )
  expect(link).not.toBeNull()
  expect(container.querySelector('a[href*="markread"]')).toBeNull()
})

test("a broken chain is an alert naming the seq", async () => {
  serve((url) =>
    url.includes("/audit/chain") ? Response.json(chainBroken) : page([autoRow])
  )
  await render()
  const alert = container.querySelector('[role="alert"]')
  expect(alert?.textContent).toBe(
    "Audit chain broken at entry 1207. Log entries after this point cannot be trusted."
  )
  expect(text()).not.toContain("verified")
})

test("an unreachable chain is never green and Retry re-checks", async () => {
  let fail = true
  const fetchMock = serve((url) =>
    url.includes("/audit/chain")
      ? fail
        ? "network"
        : Response.json(chainOk)
      : page([autoRow])
  )
  await render()
  expect(text()).toContain("Chain status unavailable")
  expect(text()).not.toContain("verified")
  fail = false
  await click("Retry")
  expect(text()).toContain("Audit chain verified")
  expect(
    fetchMock.mock.calls.filter(([u]) => urlOf(u).includes("/audit/chain"))
  ).toHaveLength(2)
})

test("Verify again re-fetches and never shows a stale green state while checking", async () => {
  let release: (r: Response) => void = () => undefined
  let calls = 0
  serve((url) => {
    if (!url.includes("/audit/chain")) return page([autoRow])
    calls += 1
    return calls === 1
      ? Response.json(chainOk)
      : new Promise<Response>((resolve) => (release = resolve))
  })
  await render()
  await click("Verify again")
  expect(text()).toContain("Verifying audit chain…")
  expect(text()).not.toContain("Audit chain verified")
  act(() => release(Response.json(chainBroken)))
  await settle()
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
})

test("Load more passes the lowest seq, adds the next page without duplicates, then disappears", async () => {
  const first = rows(50, 51)
  const fetchMock = serve((url) => {
    if (url.includes("/audit/chain")) return Response.json(chainOk)
    return url.includes("before=51")
      ? page([first[49], ...rows(49, 1)])
      : page(first, 51)
  })
  await render()
  expect(seqs()).toBe(50)
  await click("Load more")
  const auditCalls = fetchMock.mock.calls
    .map(([u]) => urlOf(u))
    .filter((u) => u.includes("/audit?"))
  expect(auditCalls).toEqual([
    "/api/gate/audit?limit=50",
    "/api/gate/audit?limit=50&before=51",
  ])
  expect(seqs()).toBe(99)
  expect(
    [...container.querySelectorAll("button")].map((b) => b.textContent)
  ).not.toContain("Load more")
})

test("a failed Load more keeps the list and offers a retry", async () => {
  let fail = true
  serve((url) => {
    if (url.includes("/audit/chain")) return Response.json(chainOk)
    if (url.includes("before="))
      return fail ? new Response(null, { status: 500 }) : page(rows(1, 1))
    return page(rows(2, 2), 2)
  })
  await render()
  await click("Load more")
  expect(text()).toContain("Could not load more entries.")
  expect(seqs()).toBe(2)
  fail = false
  await click("Retry loading more")
  expect(seqs()).toBe(3)
})

test("empty, error with Retry (chain banner still shown), and offline", async () => {
  serve((url) =>
    url.includes("/audit/chain") ? Response.json(chainOk) : page([])
  )
  await render()
  expect(text()).toContain("No activity yet.")

  let mode: "error" | "ok" = "error"
  serve((url) =>
    url.includes("/audit/chain")
      ? Response.json(chainOk)
      : mode === "error"
        ? new Response(null, { status: 500 })
        : page([autoRow])
  )
  await render()
  expect(text()).toContain("Could not read the audit log.")
  expect(text()).toContain("Audit chain verified")
  mode = "ok"
  await click("Retry")
  expect(text()).toContain("email.markRead")

  serve(() => "network")
  await render()
  expect(text()).toContain("Offline. Activity is not stored on this device.")
})

test("the page issues only GET requests and stores nothing on the device", async () => {
  const fetchMock = serve((url) =>
    url.includes("/audit/chain")
      ? Response.json(chainOk)
      : page([intentRow, alertRow], 100)
  )
  await render()
  await click("Load more")
  await click("Verify again")
  for (const [, init] of fetchMock.mock.calls)
    expect(init?.method ?? "GET").toBe("GET")
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
  expect(
    container.querySelector("input, textarea, [contenteditable]")
  ).toBeNull()
})

test("an intent's history lists entries in order with time, from to to, actor and reason", async () => {
  const fetchMock = serve(() => Response.json(history))
  await render(INTENT_ID)
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    `/api/gate/approvals/${INTENT_ID}/history`
  )
  const items = [...container.querySelectorAll("ol > li")].map(
    (li) => li.textContent
  )
  expect(items).toHaveLength(2)
  expect(items[0]).toContain("start")
  expect(items[0]).toContain("proposed")
  expect(items[0]).toContain("data-plane")
  expect(items[1]).toContain("proposed → approved")
  expect(items[1]).toContain("approver")
  expect(items[1]).toContain("Reason: looks right")
  expect(container.querySelector('a[href="/activity"]')).not.toBeNull()
  expect(localStorage.length).toBe(0)
})

test("empty history says so; a failed fetch shows an inline error and Retry recovers", async () => {
  serve(() => Response.json({ intentId: INTENT_ID, entries: [] }))
  await render(INTENT_ID)
  expect(text()).toContain("No history recorded")

  let fail = true
  serve(() =>
    fail ? new Response(null, { status: 500 }) : Response.json(history)
  )
  await render(INTENT_ID)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not read this intent's history."
  )
  fail = false
  await click("Retry")
  expect(container.querySelectorAll("ol > li")).toHaveLength(2)
})
