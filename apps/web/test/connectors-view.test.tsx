// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { ConnectorsView } from "../components/connectors-view"
import {
  AS_OF,
  driveDegraded,
  driveDisabled,
  gmail,
  sharedBridgeOpen,
} from "./fixtures/connectors"

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

async function render() {
  await act(async () => {
    root.render(<ConnectorsView />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const respond = (body: unknown, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })))
  )

const cards = () => [...container.querySelectorAll('[role="group"]')]
const cardFor = (title: string) =>
  cards().find((c) => c.querySelector("h2")?.textContent === title)

test("reads the gate's connector settings and lists exactly those connectors", async () => {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json({ connectors: [gmail, driveDegraded] }))
  )
  vi.stubGlobal("fetch", fetchMock)
  await render()
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/gate/connector-settings")
  expect(cards().map((c) => c.querySelector("h2")?.textContent)).toEqual([
    "Gmail",
    "Drive",
  ])
  const drive = cardFor("Drive")!
  expect(drive.textContent).toContain("Degraded")
  expect(drive.textContent).toContain("Backing off")
  expect(drive.textContent).toContain("Last error: upstream_timeout")
  expect(drive.textContent).toContain("Failures1")
  expect(
    drive.querySelector("time[datetime='2026-10-18T12:05:00.000Z']")
  ).not.toBeNull()
  expect(cardFor("Gmail")!.textContent).toContain("Healthy")
  expect(cardFor("Gmail")!.textContent).toContain("None scheduled")
})

test("stopping Bridge shows Proton Mail and Proton Calendar open, the others healthy", async () => {
  respond({ connectors: sharedBridgeOpen })
  await render()
  for (const title of [
    "Proton Mail (Bridge)",
    "Proton Calendar (invitations via Bridge)",
  ]) {
    const card = cardFor(title)!
    expect(card.textContent).toContain("Open")
    expect(card.textContent).toContain("Failures3")
    expect(card.textContent).toContain("Last error: bridge_handshake_failed")
  }
  expect(cardFor("Gmail")!.textContent).toContain("Healthy")
  expect(cardFor("Drive")!.textContent).toContain("Healthy")
  expect(container.textContent).toContain(
    "Proton Bridge is paused. Proton Mail and Proton Calendar invitations wait."
  )
  expect(
    cardFor("Proton Calendar (invitations via Bridge)")!.textContent
  ).toContain("Invitations wait while Bridge is paused.")
  expect(cardFor("Proton Mail (Bridge)")!.textContent).not.toContain(
    "Invitations wait"
  )
})

test("a disabled connector shows as disabled, not healthy", async () => {
  respond({ connectors: [gmail, driveDisabled] })
  await render()
  const drive = cardFor("Drive")!
  expect(drive.textContent).toContain("Disabled")
  expect(drive.textContent).not.toContain("Healthy")
})

test("the page has no controls other than Retry, and renders no secrets", async () => {
  respond({ connectors: sharedBridgeOpen })
  await render()
  expect(
    container.querySelectorAll("button, input, select, textarea, a")
  ).toHaveLength(0)
})

test("a gate error shows the error message with Retry", async () => {
  respond({}, 500)
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not read connector status from the gate."
  )
  expect(container.querySelector("button")?.textContent).toBe("Retry")
})

test("a malformed response is an error, not a list", async () => {
  respond({ connectors: [{ name: "gmail" }] })
  await render()
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(cards()).toHaveLength(0)
})

test("retry reads again", async () => {
  respond({}, 500)
  await render()
  respond({ connectors: [gmail] })
  await act(async () => {
    container.querySelector("button")!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(cards()).toHaveLength(1)
})

test("offline renders no rows and nothing is written to browser storage", async () => {
  respond({ connectors: sharedBridgeOpen })
  await render()
  expect(cards()).toHaveLength(4)
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
  act(() => root.unmount())
  root = createRoot(container)
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() => Promise.reject(new TypeError("network")))
  )
  await render()
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Offline. Connector status is not stored on this device."
  )
  expect(container.querySelector("button")?.textContent).toBe("Retry")
  expect(cards()).toHaveLength(0)
  expect(container.textContent).not.toContain("Gmail")
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
})

test("an expired session goes to unlock", async () => {
  const replace = vi.fn()
  vi.stubGlobal("location", { pathname: "/connectors", search: "", replace })
  respond({}, 401)
  await render()
  expect(replace).toHaveBeenCalledOnce()
})

test("as_of of a fresh read is the read time", async () => {
  respond({ connectors: [gmail] })
  await render()
  expect(
    container.querySelector("h1")?.nextElementSibling?.textContent
  ).toMatch(/^Status as of /)
  expect(AS_OF).toBeTruthy()
})
