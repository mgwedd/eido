// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { ThemeProvider } from "../components/theme-provider"
import { SettingsView } from "../components/settings-view"
import {
  activePasskey,
  backupFresh,
  backupNeverRun,
  backupStale,
  currentPasskey,
  chainBroken,
  chainOk,
  permissions,
  permissionsNoForbidden,
  revokedPasskey,
} from "./fixtures/settings"
import { signedRoots } from "./fixtures/file-roots"

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
  "/api/gate/backup/status": ok(backupFresh),
  "/api/gate/audit/chain": ok(chainOk),
  "/api/gate/file-roots": ok(signedRoots),
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
    "Data",
    "Security",
    "About",
  ])
})

test("profile is reached by row, not an h2 section", async () => {
  gate(healthy)
  await render()
  expect(
    [...container.querySelectorAll("h2")].map((h) => h.textContent)
  ).not.toContain("Profile")
})

test("a phone-only row links to the Profile page", async () => {
  gate(healthy)
  await render()
  const link = container.querySelector('a[href="/profile"]')
  expect(link?.textContent).toBe("Profile")
  expect(link?.className).toContain("md:hidden")
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

test("data shows the last backup time when fresh", async () => {
  gate(healthy)
  await render()
  const dataCard = [...container.querySelectorAll("[role=group]")].find((g) =>
    g.textContent?.includes("Last backup")
  )!
  expect(dataCard).not.toBeNull()
  expect(dataCard.textContent).toContain("Last backup")
  expect(dataCard.querySelector("time")?.getAttribute("datetime")).toBe(
    backupFresh.lastSuccess
  )
  expect(dataCard.textContent).not.toContain("Stale")
  expect(dataCard.textContent).not.toContain("No backup yet")
})

test("data shows the last backup time and a stale state past 36 hours", async () => {
  gate({ ...healthy, "/api/gate/backup/status": ok(backupStale) })
  await render()
  const dataCard = [...container.querySelectorAll("[role=group]")].find((g) =>
    g.textContent?.includes("Last backup")
  )!
  expect(dataCard.querySelector("time")?.getAttribute("datetime")).toBe(
    backupStale.lastSuccess
  )
  expect(dataCard.textContent).toContain("Stale")
  expect(dataCard.querySelector(".bg-amber-500")).not.toBeNull()
})

test("data shows amber 'No backup yet' when backup has never run", async () => {
  gate({ ...healthy, "/api/gate/backup/status": ok(backupNeverRun) })
  await render()
  const dataCard = [...container.querySelectorAll("[role=group]")].find((g) =>
    g.textContent?.includes("Last backup")
  )!
  expect(dataCard.textContent).toContain("No backup yet")
  expect(dataCard.querySelector('[role="status"]')?.textContent).toBe(
    "No backup yet"
  )
})

test("data read failure shows offline and error messages", async () => {
  gate({
    ...healthy,
    "/api/gate/backup/status": () => new Response("{}", { status: 500 }),
  })
  await render()
  expect(text()).toContain("Could not read backup status from the gate.")

  act(() => root.unmount())
  root = createRoot(container)
  gate({
    ...healthy,
    "/api/gate/backup/status": () => {
      throw new TypeError("net")
    },
  })
  await render()
  expect(text()).toContain(
    "Offline. Backup status is not stored on this device."
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
  expect(fn.mock.calls.length).toBe(before + 5)
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

test("data lists the signed folder count and links to Review", async () => {
  gate(healthy)
  await render()
  const data = container.querySelector('[aria-labelledby="settings-data"]')
  expect(data?.textContent).toContain("2 allowed folders")
  const review = [...(data?.querySelectorAll("a") ?? [])].find(
    (a) => a.textContent === "Review"
  )
  expect(review?.getAttribute("href")).toBe("/settings/folders/review")
})

test("data links to the folder editor whether or not folders are signed", async () => {
  gate({ ...healthy, "/api/gate/file-roots": ok({ roots: [] }) })
  await render()
  const data = container.querySelector('[aria-labelledby="settings-data"]')
  const edit = [...(data?.querySelectorAll("a") ?? [])].find(
    (a) => a.textContent === "Edit"
  )
  expect(edit?.getAttribute("href")).toBe("/settings/folders/edit")
})

test("data with no signed folders offers no Review", async () => {
  gate({ ...healthy, "/api/gate/file-roots": ok({ roots: [] }) })
  await render()
  const data = container.querySelector('[aria-labelledby="settings-data"]')
  expect(data?.textContent).toContain("No allowed folders")
  expect(
    [...(data?.querySelectorAll("a") ?? [])].some(
      (a) => a.textContent === "Review"
    )
  ).toBe(false)
})

test("a folder list the gate cannot read says so", async () => {
  gate({
    ...healthy,
    "/api/gate/file-roots": () => new Response("{}", { status: 500 }),
  })
  await render()
  expect(text()).toContain("Could not read allowed folder list from the gate.")
})
