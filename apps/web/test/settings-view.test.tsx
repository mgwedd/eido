// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { ThemeProvider } from "../components/theme-provider"
import { SettingsView } from "../components/settings-view"
import {
  activePasskey,
  currentPasskey,
  chainBroken,
  chainOk,
  permissions,
  permissionsNoForbidden,
  revokedPasskey,
} from "./fixtures/settings"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  document.documentElement.className = ""
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "9.9.9")
  vi.stubEnv("NEXT_PUBLIC_BUILD_ID", "deadbeef0001")
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url

type Routes = Partial<Record<string, () => Response | Promise<Response>>>

const ok = (body: unknown) => () => new Response(JSON.stringify(body))

function gate(routes: Routes) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const handler = routes[requestUrl(input)]
    return handler
      ? Promise.resolve(handler())
      : Promise.reject(new TypeError("net"))
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

const healthy: Routes = {
  "/api/gate/passkeys": ok({
    passkeys: [activePasskey, currentPasskey, revokedPasskey],
  }),
  "/api/gate/permissions": ok(permissions),
  "/api/gate/audit/chain": ok(chainOk),
}

async function render() {
  await act(async () => {
    root.render(
      <ThemeProvider>
        <SettingsView />
      </ThemeProvider>
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const text = () => container.textContent ?? ""

test("shows the sections in the issue's order", async () => {
  gate(healthy)
  await render()
  const headings = [...container.querySelectorAll("h2")].map(
    (h) => h.textContent
  )
  expect(headings).toEqual([
    "Appearance",
    "Notifications",
    "Devices and passkeys",
    "Assistant behaviour",
    "Security",
    "About",
  ])
})

test("omits sections whose data source does not exist: no Profile or Data", async () => {
  gate(healthy)
  await render()
  for (const absent of ["Profile", "Data"])
    expect(
      [...container.querySelectorAll("h2")].map((h) => h.textContent)
    ).not.toContain(absent)
  expect(container.querySelector('a[href="/profile"]')).toBeNull()
})

test("lists passkeys with created time, this device and revoked status", async () => {
  gate(healthy)
  await render()
  const items = [...container.querySelectorAll("section, [role=group]")]
    .find((g) => g.textContent?.includes("Devices and passkeys"))!
    .querySelectorAll("li")
  expect(items).toHaveLength(3)
  expect(items[0]?.textContent).toContain("aaaaaaaa")
  expect(items[0]?.textContent).toContain("Active")
  expect(items[0]?.textContent).not.toContain("This device")
  expect(items[0]?.querySelector("time")?.getAttribute("datetime")).toBe(
    activePasskey.createdAt
  )
  expect(items[1]?.textContent).toContain("This device")
  expect(items[1]?.textContent).not.toContain("Active")
  expect(items[2]?.textContent).toContain("Revoked")
  expect(items[2]?.querySelectorAll("time")).toHaveLength(2)
})

test("an empty passkey list says none is enrolled", async () => {
  gate({ ...healthy, "/api/gate/passkeys": ok({ passkeys: [] }) })
  await render()
  expect(text()).toContain("No passkey is enrolled.")
})

test("permissions show each kind's effective tier and the forbidden kinds", async () => {
  gate(healthy)
  await render()
  expect(text()).toContain("reminder.create")
  expect(text()).toContain("Automatic")
  expect(text()).toContain("Needs approval")
  const forbidden = container.querySelector('[aria-label="Forbidden kinds"]')
  expect(forbidden?.textContent).toBe("file.delete")
})

test("no forbidden list when no kind is forbidden", async () => {
  gate({ ...healthy, "/api/gate/permissions": ok(permissionsNoForbidden) })
  await render()
  expect(container.querySelector('[aria-label="Forbidden kinds"]')).toBeNull()
})

test("security shows the chain result, including a broken chain", async () => {
  gate(healthy)
  await render()
  expect(text()).toContain("OK, 42 rows")
  act(() => root.unmount())
  root = createRoot(container)
  gate({ ...healthy, "/api/gate/audit/chain": ok(chainBroken) })
  await render()
  expect(text()).toContain("Broken at sequence 7")
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "A row does not link to the one before it."
  )
})

test("about shows the build's version and id", async () => {
  gate(healthy)
  await render()
  expect(text()).toContain("9.9.9")
  expect(text()).toContain("deadbeef0001")
})

test("no control revokes a passkey or edits permissions", async () => {
  gate(healthy)
  await render()
  const labels = [...container.querySelectorAll("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent ?? ""
  )
  expect(labels.join("|")).not.toMatch(/^(remove|revoke|edit|delete)/i)
  // The only controls that change anything are the theme radios and the push switch.
  // The switch mirrors its state into an aria-hidden checkbox input, which is not a
  // control of its own.
  const controls = [
    ...container.querySelectorAll(
      "input, select, textarea, [role=switch], [role=radio], [role=checkbox], [role=combobox], [role=textbox], [role=slider], [role=spinbutton]"
    ),
  ]
    .filter((control) => control.getAttribute("aria-hidden") !== "true")
    .map((control) => [
      control.closest("[aria-labelledby]")?.getAttribute("aria-labelledby"),
      control.getAttribute("role") ?? control.tagName.toLowerCase(),
      control.getAttribute("aria-label") ?? control.textContent,
    ])
  expect(controls).toEqual([
    ["settings-appearance", "radio", "Dark"],
    ["settings-appearance", "radio", "Light"],
    ["settings-appearance", "radio", "System"],
    ["settings-notifications", "switch", "Push on this device"],
  ])
  // No write requests were made either.
  const fn = vi.mocked(fetch)
  for (const call of fn.mock.calls) expect(call[1]?.method ?? "GET").toBe("GET")
})

test("a section whose read fails says so; the others still render; retry reloads", async () => {
  const fn = gate({
    ...healthy,
    "/api/gate/permissions": () => new Response("{}", { status: 500 }),
    "/api/gate/audit/chain": () => {
      throw new TypeError("net")
    },
  })
  await render()
  expect(text()).toContain("Could not read permissions from the gate.")
  expect(text()).toContain(
    "Offline. Audit chain status is not stored on this device."
  )
  expect(text()).toContain("aaaaaaaa")
  const before = fn.mock.calls.length
  const retry = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Retry"
  )!
  await act(async () => {
    retry.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(fn.mock.calls.length).toBe(before + 3)
})

test("an expired session sends the user to unlock", async () => {
  gate({
    ...healthy,
    "/api/gate/passkeys": () => new Response("{}", { status: 401 }),
  })
  const replace = vi.fn()
  vi.stubGlobal("location", {
    ...window.location,
    replace,
    pathname: "/settings",
    search: "",
  })
  await render()
  expect(replace).toHaveBeenCalledTimes(1)
  expect(String(replace.mock.calls[0]?.[0])).toContain("/unlock")
})

test("gate data is never written to device storage; only the theme is", async () => {
  gate(healthy)
  await render()
  const dark = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Light"
  )!
  act(() => dark.click())
  const keys = Object.keys(localStorage)
  expect(keys).toEqual(["theme"])
  expect(localStorage.getItem("theme")).toBe("light")
  expect(sessionStorage.length).toBe(0)
  expect(document.documentElement.classList.contains("dark")).toBe(false)
})

test("theme defaults to dark on first load", async () => {
  gate(healthy)
  await render()
  expect(document.documentElement.classList.contains("dark")).toBe(true)
  const radios = [...container.querySelectorAll('[role="radio"]')]
  expect(
    radios.map((r) => [r.textContent, r.getAttribute("aria-checked")])
  ).toEqual([
    ["Dark", "true"],
    ["Light", "false"],
    ["System", "false"],
  ])
})

test("how-it-works tooltip opens from a tap on its focusable trigger", async () => {
  gate(healthy)
  await render()
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="About Devices and passkeys"]'
  )!
  expect(trigger.tagName).toBe("BUTTON")
  act(() => trigger.click())
  expect(document.body.textContent).toContain(
    "enrolled and removed from the Mac"
  )
})
