// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { stubIphone } from "./platform"
import { repinConnector } from "../lib/connector-repin"
import { ConnectorsView } from "../components/connectors-view"
import { formatDateTime } from "../lib/connectors"
import {
  AS_OF,
  drive,
  driveDegraded,
  driveDisabled,
  driveDrifted,
  gmail,
  protonMailOpen,
  sharedBridgeOpen,
} from "./fixtures/connectors"

vi.mock("../lib/connector-repin", () => ({ repinConnector: vi.fn() }))
const repin = vi.mocked(repinConnector)

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
  repin.mockReset()
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

test("the header shows the gate's asOf, not the browser's fetch time", async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"))
  try {
    respond({ connectors: [gmail], asOf: AS_OF })
    await render()
  } finally {
    vi.useRealTimers()
  }
  const header = container.querySelector("h1")?.nextElementSibling?.textContent
  expect(header).toBe(`Status as of ${formatDateTime(AS_OF)}`)
  expect(header).not.toContain("2030")
})

test("no data time is shown when the gate sends no asOf", async () => {
  respond({ connectors: [gmail] })
  await render()
  expect(container.querySelector("h1")?.nextElementSibling?.textContent).toBe(
    ""
  )
})

test("a healthy connector shows its last sync and manifest hash", async () => {
  respond({ connectors: [gmail] })
  await render()
  const card = cardFor("Gmail")!
  expect(
    card.querySelector("time[datetime='2026-10-18T11:28:00.000Z']")?.textContent
  ).toBe(formatDateTime("2026-10-18T11:28:00.000Z"))
  expect(card.textContent).toContain("Last sync")
  expect(card.textContent).toContain(gmail.manifestHash)
  expect(card.textContent).not.toContain("Manifest drift")
})

test("a connector without lastSuccessAt shows no last sync", async () => {
  respond({ connectors: [drive] })
  await render()
  const card = cardFor("Drive")!
  expect(card.textContent).not.toContain("Last sync")
  expect(card.textContent).toContain(drive.manifestHash)
})

test("an open connector shows its manifest hash beside the failure detail", async () => {
  respond({ connectors: sharedBridgeOpen })
  await render()
  const card = cardFor("Proton Mail (Bridge)")!
  expect(card.textContent).toContain(protonMailOpen.manifestHash)
  expect(card.textContent).not.toContain("Last sync")
  expect(card.textContent).not.toContain("Manifest drift")
})

test("a drift-disabled connector lists added and removed tools and reads unlike a manual disable", async () => {
  respond({ connectors: [driveDrifted] })
  await render()
  const card = cardFor("Drive")!
  expect(card.textContent).toContain(
    "Disabled: the tool manifest changed since it was pinned."
  )
  const drift = card.querySelector("section")!
  expect(drift.textContent).toContain("Manifest drift")
  expect([...drift.querySelectorAll("li")].map((li) => li.textContent)).toEqual(
    ["+ drive.move_bulk", "- drive.save"]
  )
})

test("a manually disabled connector shows no drift section", async () => {
  respond({ connectors: [driveDisabled] })
  await render()
  const card = cardFor("Drive")!
  expect(card.querySelector("section")).toBeNull()
  expect(card.textContent).toContain(
    "Disabled: the gate refuses reads from this connector"
  )
  expect(card.textContent).not.toContain("tool manifest changed")
})

test("a connector that is not drift-disabled has no re-pin action", async () => {
  respond({ connectors: [driveDisabled, gmail] })
  await render()
  expect(container.textContent).not.toContain("Review and re-pin")
})

test("Review and re-pin signs, then reloads the connectors so the card shows enabled", async () => {
  let reads = 0
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.endsWith("/repin")) return Promise.resolve(Response.json({}))
    reads += 1
    return Promise.resolve(
      Response.json({ connectors: [reads === 1 ? driveDrifted : drive] })
    )
  })
  vi.stubGlobal("fetch", fetchMock)
  repin.mockResolvedValueOnce({ ok: true })
  await render()
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Review and re-pin"
  )!
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(repin).toHaveBeenCalledWith("drive", driveDrifted.drift)
  expect(reads).toBe(2)
  expect(container.textContent).not.toContain("Review and re-pin")
  expect(cardFor("Drive")!.textContent).not.toContain("Disabled")
})

test("a refused re-pin shows the message, keeps the connector disabled and re-enables the button", async () => {
  respond({ connectors: [driveDrifted] })
  repin.mockResolvedValueOnce({
    ok: false,
    message: "The gate refused the signature. The old pin is unchanged.",
  })
  await render()
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Review and re-pin"
  )!
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "The gate refused the signature. The old pin is unchanged."
  )
  expect(cardFor("Drive")!.textContent).toContain("Disabled")
  expect(button.disabled).toBe(false)
})

async function startRepin() {
  respond({ connectors: [driveDrifted] })
  repin.mockReturnValueOnce(new Promise(() => undefined))
  await render()
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Review and re-pin"
  )!
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return button
}

const statusTexts = () =>
  [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent)

test("while the passkey prompt is open the card says it is waiting for the passkey", async () => {
  const button = await startRepin()
  expect(statusTexts()).toContain("Waiting for your passkey…")
  expect(button.disabled).toBe(true)
})

test("on an iPhone the waiting card names Face ID", async () => {
  stubIphone()
  await startRepin()
  expect(statusTexts()).toContain("Waiting for Face ID…")
})

test("an expired session during re-pin sends the owner to unlock", async () => {
  respond({ connectors: [driveDrifted] })
  repin.mockResolvedValueOnce({ ok: false, expired: true })
  const replace = vi.fn()
  vi.stubGlobal("location", {
    ...window.location,
    replace,
    pathname: "/connectors",
    search: "",
  })
  await render()
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Review and re-pin"
  )!
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(replace).toHaveBeenCalledTimes(1)
  expect(String(replace.mock.calls[0]![0])).toContain("/unlock")
})
