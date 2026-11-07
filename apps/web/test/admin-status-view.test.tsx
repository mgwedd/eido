// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AdminStatusView } from "../components/admin-status-view"
import {
  doctorAllOk,
  doctorMixed,
  job,
  running,
  stackAvailable,
  stackUnavailable,
  starting,
  stopped,
} from "./fixtures/admin-status"

const admin = vi.hoisted(() => ({
  elevated: vi.fn(),
  sessionEnded: vi.fn(),
}))
vi.mock("../components/admin-step-up", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useAdmin: () => admin,
}))

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  admin.elevated.mockImplementation((_action: string, run: () => unknown) =>
    run()
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  admin.elevated.mockReset()
  admin.sessionEnded.mockReset()
})

const urlOf = (input: Parameters<typeof fetch>[0]) =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url

const apiError = (status: number, code: string) =>
  Response.json({ code, message: code }, { status })

type Table = Record<string, () => Response>

/** Answers each gate path from `table`; the table can change between calls. */
function gate(table: Table) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const path = urlOf(input).replace("/api/gate", "")
    const make = table[path]
    return Promise.resolve(make ? make() : apiError(404, "not_found"))
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const healthy = (processes = running, enabled = true): Table => ({
  "/admin/stack": () => Response.json(stackAvailable(processes)),
  "/admin/doctor": () => Response.json(doctorMixed),
  "/admin/login-item": () => Response.json({ enabled }),
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function render() {
  await act(async () => {
    root.render(<AdminStatusView />)
    await settle()
  })
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).click()
    await settle()
  })
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label)
  )
const status = () => container.querySelector('[role="status"]')?.textContent
const alert = () => container.querySelector('[role="alert"]')?.textContent
const callsTo = (fetchMock: ReturnType<typeof gate>, path: string) =>
  fetchMock.mock.calls.filter(([url]) => url === `/api/gate${path}`)

test("shows the four processes, with controls only for core and llama", async () => {
  gate(healthy())
  await render()
  const rows = [...container.querySelectorAll('[aria-label="Processes"] li')]
  expect(rows.map((r) => r.textContent)).toEqual([
    "gateRunningAlways on",
    "webRunningAlways on",
    "coreRunning",
    "llamaRunning",
  ])
  expect(button("Stop")).toBeTruthy()
  expect(button("Restart")).toBeTruthy()
  expect(button("Start")).toBeUndefined()
})

test("Restart is an elevated call that posts both names and then follows the job", async () => {
  const table = healthy()
  const fetchMock = gate(table)
  table["/admin/stack/restart"] = () =>
    Response.json(job(starting), { status: 202 })
  await render()
  await click(button("Restart"))
  expect(admin.elevated).toHaveBeenCalledWith(
    "Restart core and llama",
    expect.any(Function)
  )
  const [, init] = callsTo(fetchMock, "/admin/stack/restart")[0] ?? []
  expect(init?.method).toBe("POST")
  expect(init?.body).toBe(JSON.stringify({ names: ["core", "llama"] }))
  expect(status()).toBe("Starting core and llama…")
  expect(button("Stop")).toBeUndefined()
})

test("the controls are disabled and the live region says what is happening while the call runs", async () => {
  gate(healthy())
  let finish: (value: unknown) => void = () => undefined
  admin.elevated.mockImplementation(
    () => new Promise((resolve) => (finish = resolve))
  )
  await render()
  await click(button("Restart"))
  expect(status()).toBe("Restarting core and llama…")
  expect(button("Stop")?.disabled).toBe(true)
  await act(async () => {
    finish({ kind: "cancelled" })
    await settle()
  })
  expect(status()).toBe("core running, llama running.")
  expect(button("Stop")?.disabled).toBe(false)
})

test("a cancelled step-up changes nothing and says nothing", async () => {
  gate(healthy())
  admin.elevated.mockResolvedValue({ kind: "cancelled" })
  await render()
  await click(button("Stop"))
  expect(alert()).toBeUndefined()
  expect(status()).toBe("core running, llama running.")
})

test("stopped shows only Start, which posts to /admin/stack/start", async () => {
  const table = healthy(stopped)
  const fetchMock = gate(table)
  table["/admin/stack/start"] = () =>
    Response.json(job(starting), { status: 202 })
  await render()
  expect(status()).toBe(
    "Core and llama are stopped. Ask, sync and the queue wait until you start them."
  )
  expect(button("Stop")).toBeUndefined()
  expect(button("Restart")).toBeUndefined()
  await click(button("Start"))
  expect(callsTo(fetchMock, "/admin/stack/start")).toHaveLength(1)
  expect(status()).toBe("Starting core and llama…")
})

test("a refused job shows its reason and keeps the controls", async () => {
  const table = healthy()
  gate(table)
  table["/admin/stack/stop"] = () => apiError(503, "busy")
  await render()
  await click(button("Stop"))
  expect(alert()).toBe("Another stack job is running.")
  expect(button("Stop")?.disabled).toBe(false)
})

test("an unrecognised refusal falls back to the verb", async () => {
  const table = healthy()
  gate(table)
  table["/admin/stack/stop"] = () => apiError(502, "supervisor_failed")
  await render()
  await click(button("Stop"))
  expect(alert()).toBe("Could not stop core and llama.")
})

test("a job answer that does not match the schema is reported, not shown as success", async () => {
  const table = healthy()
  gate(table)
  table["/admin/stack/stop"] = () => Response.json({ nope: true })
  await render()
  await click(button("Stop"))
  expect(alert()).toBe("Could not stop core and llama.")
})

test("losing the gate during a job shows the unreachable state", async () => {
  gate(healthy())
  admin.elevated.mockResolvedValue({ kind: "unreachable" })
  await render()
  await click(button("Stop"))
  expect(alert()).toContain("Can't reach the gate on the host.")
})

test("while the supervisor reports a job running, the processes are read again until it settles", async () => {
  vi.useFakeTimers()
  const table = healthy(starting)
  const fetchMock = gate(table)
  await act(async () => {
    root.render(<AdminStatusView />)
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(status()).toBe("Starting core and llama…")
  table["/admin/stack"] = () => Response.json(stackAvailable(running))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(status()).toBe("core running, llama running.")
  expect(callsTo(fetchMock, "/admin/stack")).toHaveLength(2)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(callsTo(fetchMock, "/admin/stack")).toHaveLength(2)
})

test("supervisor down hides the controls and the checks and shows only the gate", async () => {
  const fetchMock = gate({
    "/admin/stack": () => Response.json(stackUnavailable),
  })
  await render()
  expect(container.textContent).toContain("pnpm stack:status")
  expect(container.querySelector("code")?.textContent).toBe("pnpm stack:status")
  expect(
    [...container.querySelectorAll('[aria-label="Processes"] li')].map(
      (r) => r.textContent
    )
  ).toEqual(["gateRunningserving this page"])
  expect(container.querySelectorAll("button")).toHaveLength(0)
  expect(container.textContent).not.toContain("Checks")
  expect(callsTo(fetchMock, "/admin/doctor")).toHaveLength(0)
})

test("Retry reads the gate again after an error", async () => {
  const table: Table = { "/admin/stack": () => apiError(500, "internal") }
  const fetchMock = gate(table)
  await render()
  expect(alert()).toContain("Could not read the stack status from the gate.")
  Object.assign(table, healthy())
  await click(button("Retry"))
  expect(callsTo(fetchMock, "/admin/stack")).toHaveLength(2)
  expect(status()).toBe("core running, llama running.")
})

test("an ended session sends the owner to sign in and shows no content", async () => {
  gate({ "/admin/stack": () => apiError(401, "unauthenticated") })
  await render()
  expect(admin.sessionEnded).toHaveBeenCalledTimes(1)
  expect(status()).toBe("Loading the stack status…")
})

test("Start at login shows its state and turning it off is an elevated post", async () => {
  const table = healthy(running, true)
  const fetchMock = gate(table)
  table["/admin/login-item"] = () => Response.json({ enabled: true })
  await render()
  const toggle = container.querySelector('[role="switch"]')
  expect(toggle?.getAttribute("aria-checked")).toBe("true")
  expect(container.textContent).toContain("Loaded")
  table["/admin/login-item"] = () => Response.json({ enabled: false })
  await click(toggle)
  expect(admin.elevated).toHaveBeenCalledWith(
    "Stop starting the stack at login",
    expect.any(Function)
  )
  const post = callsTo(fetchMock, "/admin/login-item").find(
    ([, init]) => init?.method === "POST"
  )
  expect(post?.[1]?.body).toBe(JSON.stringify({ enabled: false }))
  expect(
    container.querySelector('[role="switch"]')?.getAttribute("aria-checked")
  ).toBe("false")
  expect(container.textContent).toContain("Not loaded")
})

test("turning Start at login on asks for the matching elevated action", async () => {
  const table = healthy(running, false)
  gate(table)
  await render()
  table["/admin/login-item"] = () => Response.json({ enabled: true })
  await click(container.querySelector('[role="switch"]'))
  expect(admin.elevated).toHaveBeenCalledWith(
    "Start the stack at login",
    expect.any(Function)
  )
  expect(container.textContent).toContain("Loaded")
})

test("a refused login item change keeps the switch and says so", async () => {
  const table = healthy(running, true)
  gate(table)
  await render()
  table["/admin/login-item"] = () => apiError(502, "supervisor_failed")
  await click(container.querySelector('[role="switch"]'))
  expect(alert()).toBe("Could not change Start at login.")
  expect(
    container.querySelector('[role="switch"]')?.getAttribute("aria-checked")
  ).toBe("true")
})

test("losing the gate while changing the login item shows the unreachable state", async () => {
  gate(healthy())
  admin.elevated.mockResolvedValue({ kind: "unreachable" })
  await render()
  await click(container.querySelector('[role="switch"]'))
  expect(alert()).toContain("Can't reach the gate on the host.")
})

test("on a platform without a login item the row links the issue and has no switch", async () => {
  const table = healthy()
  gate(table)
  table["/admin/login-item"] = () => apiError(501, "unsupported_platform")
  await render()
  expect(container.querySelector('[role="switch"]')).toBeNull()
  expect(container.textContent).toContain("Not on Windows yet · issue 455")
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/mgwedd/eido/issues/455"
  )
})

test("a login item that cannot be read says so without a switch", async () => {
  const table = healthy()
  gate(table)
  table["/admin/login-item"] = () => apiError(502, "supervisor_failed")
  await render()
  expect(container.querySelector('[role="switch"]')).toBeNull()
  expect(container.textContent).toContain("Could not read this setting.")
})

test("checks list failures and warnings with their fixes, and fold the OK ones", async () => {
  gate(healthy())
  await render()
  expect(container.textContent).toContain("3 OK · 2 warnings · 1 failed")
  const issues = [
    ...container.querySelectorAll('[aria-label="Checks needing attention"] li'),
  ]
  expect(issues.map((li) => li.querySelector("code")?.textContent)).toEqual([
    "llama-health",
    "keychain",
    "tailscale",
  ])
  expect(issues[0]?.textContent).toContain("Failed")
  expect(issues[0]?.textContent).toContain("Fix: Start llama: press Restart.")
  expect(issues[2]?.textContent).not.toContain("Fix:")
  expect(
    container.querySelector('[aria-label="Checks that passed"]')
  ).toBeNull()
  const fold = button("3 more OK")
  expect(fold?.getAttribute("aria-expanded")).toBe("false")
  expect(container.textContent).toContain("node · vault · ports")
  await click(fold)
  expect(fold?.getAttribute("aria-expanded")).toBe("true")
  expect(
    [...container.querySelectorAll('[aria-label="Checks that passed"] li')].map(
      (li) => li.querySelector("code")?.textContent
    )
  ).toEqual(["node", "vault", "ports"])
})

test("with nothing to fix the OK checks are listed, with no fold", async () => {
  const table = healthy()
  gate(table)
  table["/admin/doctor"] = () => Response.json(doctorAllOk)
  await render()
  expect(button("more OK")).toBeUndefined()
  expect(
    container.querySelectorAll('[aria-label="Checks that passed"] li')
  ).toHaveLength(2)
})

test("a doctor read that fails says so in the Checks card", async () => {
  const table = healthy()
  gate(table)
  table["/admin/doctor"] = () => apiError(502, "supervisor_failed")
  await render()
  expect(container.textContent).toContain("Could not read the checks.")
})
