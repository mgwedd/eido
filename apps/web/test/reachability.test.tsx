// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { ConnectionBanner } from "../components/connection-banner"
import { ReachabilityProvider } from "../components/reachability"
import { ServiceWorkerRegister } from "../components/service-worker-register"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function mount() {
  await act(async () => {
    root.render(
      <ReachabilityProvider>
        <ConnectionBanner />
      </ReachabilityProvider>
    )
    await settle()
  })
}

// Let the mocked fetch promise chain resolve inside act.
const settle = () => vi.advanceTimersByTimeAsync(0)

const banner = () => container.textContent ?? ""
const NOTICE = "Can't reach Eido"

test("shows nothing while the probe succeeds", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
  await mount()
  expect(fetchMock).toHaveBeenCalledWith("/healthz", { cache: "no-store" })
  expect(banner()).not.toContain(NOTICE)
})

test("shows the notice when the probe fails and recovers on retry", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("network"))
  await mount()
  expect(banner()).toContain(NOTICE)

  fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  expect(banner()).not.toContain(NOTICE)
})

test("treats a non-ok response as unreachable", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
  await mount()
  expect(banner()).toContain(NOTICE)
})

test("re-probes when the device goes online, offline or regains focus", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
  await mount()
  const before = fetchMock.mock.calls.length
  for (const name of ["online", "offline", "focus"]) {
    await act(async () => {
      window.dispatchEvent(new Event(name))
      await settle()
    })
  }
  expect(fetchMock.mock.calls.length).toBe(before + 3)
})

test("re-probes when the page becomes visible, not when hidden", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
  await mount()
  const before = fetchMock.mock.calls.length
  const visibility = vi.spyOn(document, "visibilityState", "get")
  visibility.mockReturnValue("hidden")
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
  })
  expect(fetchMock.mock.calls.length).toBe(before)
  visibility.mockReturnValue("visible")
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
  })
  expect(fetchMock.mock.calls.length).toBe(before + 1)
})

test("registers the service worker in production", async () => {
  const register = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal("navigator", { serviceWorker: { register } })
  vi.stubEnv("NODE_ENV", "production")
  await act(async () => {
    root.render(<ServiceWorkerRegister />)
    await settle()
  })
  expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" })
})

test("does not register outside production", async () => {
  const register = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal("navigator", { serviceWorker: { register } })
  await act(async () => {
    root.render(<ServiceWorkerRegister />)
    await settle()
  })
  expect(register).not.toHaveBeenCalled()
})

test("does not register when the browser has no service workers", async () => {
  vi.stubGlobal("navigator", {})
  vi.stubEnv("NODE_ENV", "production")
  await act(async () => {
    root.render(<ServiceWorkerRegister />)
    await settle()
  })
  expect(container.innerHTML).toBe("")
})
