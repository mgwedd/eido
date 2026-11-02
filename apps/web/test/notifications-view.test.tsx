// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { TooltipProvider } from "@eido/ui/components/tooltip"
import { NotificationsSection } from "../components/settings-view"
import { prepared, serverKey } from "./fixtures/push"
import {
  fakeBrowser,
  storeRegistration,
  stubWebAuthnGlobals,
  type FakeBrowser,
} from "./push-device"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  stubWebAuthnGlobals()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status })

function gate(routes: Record<string, () => Response>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const handler = routes[`${init?.method ?? "GET"} ${urlOf(input)}`]
    return handler
      ? Promise.resolve(handler())
      : Promise.reject(new TypeError("net"))
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

/**
 * Subscribing awaits crypto.subtle hashes and requests, which take an unknown number of
 * ticks: flush React inside act and retry the check until it holds.
 */
async function until(check: () => void) {
  await vi.waitFor(
    async () => {
      await tick()
      check()
    },
    { timeout: 5_000 }
  )
}

async function render(browser: FakeBrowser) {
  act(() => {
    root.render(
      <TooltipProvider>
        <NotificationsSection device={browser.device} />
      </TooltipProvider>
    )
  })
  await until(() => expect(status()).not.toBe(""))
}

const toggle = () => container.querySelector<HTMLElement>('[role="switch"]')!
const status = () => container.querySelector('[role="status"]')?.textContent
const alert = () => container.querySelector('[role="alert"]')?.textContent

async function click() {
  act(() => {
    toggle().click()
  })
  await tick()
}

const list = (ids: string[]) =>
  json({ subscriptions: ids.map((id) => ({ id })) })

test("turning the switch on registers this device and shows it subscribed", async () => {
  const fn = gate({
    "GET /api/gate/push/subscriptions": list([]),
    "GET /api/gate/push/key": json({ publicKey: serverKey }),
    "POST /api/gate/push/prepare": json(prepared),
    "POST /api/gate/push/subscriptions": json({ id: "sub-1" }, 201),
  })
  const browser = fakeBrowser({ permission: "default", answer: "granted" })
  await render(browser)
  expect(status()).toBe("Not subscribed")
  expect(toggle().getAttribute("aria-checked")).toBe("false")

  await click()
  await until(() => expect(status()).toBe("Subscribed"))
  expect(toggle().getAttribute("aria-checked")).toBe("true")
  expect(alert()).toBeUndefined()
  expect(fn.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual([
    "GET",
    "GET",
    "POST",
    "POST",
  ])
})

test("turning the switch off removes the registration at the gate", async () => {
  storeRegistration("sub-1")
  const fn = gate({
    "GET /api/gate/push/subscriptions": list(["sub-1"]),
    "POST /api/gate/push/sub-1/remove": json({ id: "sub-1" }),
  })
  const browser = fakeBrowser({ subscribed: true })
  await render(browser)
  expect(status()).toBe("Subscribed")

  await click()
  await until(() => expect(status()).toBe("Not subscribed"))
  expect(urlOf(fn.mock.calls.at(-1)?.[0] ?? "")).toBe(
    "/api/gate/push/sub-1/remove"
  )
  expect(browser.current()).toBeNull()
})

test("a failed subscribe leaves the switch off and says why", async () => {
  gate({
    "GET /api/gate/push/subscriptions": list([]),
    "GET /api/gate/push/key": json(
      { code: "unavailable", message: "push is not configured" },
      503
    ),
  })
  await render(fakeBrowser())
  await click()
  await until(() => expect(alert()).toBe("Push is not set up on the gate."))
  expect(status()).toBe("Not subscribed")
  expect(toggle().getAttribute("aria-checked")).toBe("false")
})

test("the switch is disabled while a change is in flight", async () => {
  gate({
    "GET /api/gate/push/subscriptions": list([]),
    "GET /api/gate/push/key": json({ publicKey: serverKey }),
    "POST /api/gate/push/prepare": json(prepared),
  })
  const browser = fakeBrowser({
    credential: () => new Promise(() => undefined),
  })
  await render(browser)
  await click()
  await until(() => expect(browser.credentialOptions).toHaveLength(1))
  expect(toggle().hasAttribute("data-disabled")).toBe(true)
  await click()
  await tick()
  expect(browser.credentialOptions).toHaveLength(1)
})

test.each([
  ["denied", { permission: "denied" as const }],
  ["unsupported", { supported: false }],
  ["offline", {}],
])("the switch is disabled when push is %s", async (_, options) => {
  const fn = gate({})
  const browser = fakeBrowser(options)
  await render(browser)
  expect(toggle().hasAttribute("data-disabled")).toBe(true)
  const before = fn.mock.calls.length
  await click()
  await tick()
  expect(fn.mock.calls.length).toBe(before)
  expect(browser.subscribeOptions).toEqual([])
})

test("the tooltip says pushes carry only a count", async () => {
  gate({})
  await render(fakeBrowser({ supported: false }))
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="About push on this device"]'
  )!
  act(() => trigger.click())
  expect(document.body.textContent).toContain(
    "Pushes carry only a count of waiting cards."
  )
})

const retryButton = () =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Retry"
  )

test("a failed read offers a retry that brings the switch back", async () => {
  let reads = 0
  gate({
    "GET /api/gate/push/subscriptions": () =>
      ++reads === 1 ? new Response("{}", { status: 500 }) : list([])(),
  })
  await render(fakeBrowser())
  expect(alert()).toBe("Could not read push status from the gate.")
  expect(toggle().hasAttribute("data-disabled")).toBe(true)

  act(() => {
    retryButton()?.click()
  })
  await until(() => expect(status()).toBe("Not subscribed"))
  expect(alert()).toBeUndefined()
  expect(retryButton()).toBeUndefined()
  expect(toggle().hasAttribute("data-disabled")).toBe(false)
})

function stubLocation() {
  const replace = vi.fn()
  vi.stubGlobal("location", {
    ...window.location,
    replace,
    pathname: "/settings",
    search: "",
  })
  return replace
}

test("an expired session on the status read sends the user to unlock", async () => {
  gate({ "GET /api/gate/push/subscriptions": json({}, 401) })
  const replace = stubLocation()
  act(() => {
    root.render(
      <TooltipProvider>
        <NotificationsSection device={fakeBrowser().device} />
      </TooltipProvider>
    )
  })
  await until(() => expect(replace).toHaveBeenCalledTimes(1))
  expect(replace).toHaveBeenCalledWith("/unlock?next=%2Fsettings&expired=1")
})

test("an expired session while turning push on sends the user to unlock", async () => {
  gate({
    "GET /api/gate/push/subscriptions": list([]),
    "GET /api/gate/push/key": json({}, 401),
  })
  const replace = stubLocation()
  await render(fakeBrowser())
  await click()
  await until(() => expect(replace).toHaveBeenCalledTimes(1))
  expect(replace).toHaveBeenCalledWith("/unlock?next=%2Fsettings&expired=1")
  expect(alert()).toBeUndefined()
})
