// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- fetch stubs return promises */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  activeTab,
  AdminError,
  AdminShell,
  AdminUnreachable,
} from "../components/admin-shell"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let pathname = "/admin/model"
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => pathname,
}))

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
  vi.useRealTimers()
})

describe("activeTab", () => {
  it("marks Status only on /admin itself", () => {
    expect(activeTab("/admin")).toBe("/admin")
    expect(activeTab("/admin/unknown")).toBeUndefined()
  })
  it("marks the other tabs on their path and below", () => {
    expect(activeTab("/admin/connectors")).toBe("/admin/connectors")
    expect(activeTab("/admin/devices/x")).toBe("/admin/devices")
    expect(activeTab("/admin/modelx")).toBeUndefined()
  })
})

describe("AdminUnreachable and AdminError", () => {
  it("announce the message alone and Retry calls back", async () => {
    const retry = vi.fn()
    await act(async () => {
      root.render(
        <>
          <AdminUnreachable onRetry={retry} />
          <AdminError
            message="Could not read the models from the gate."
            onRetry={retry}
          />
        </>
      )
    })
    expect(
      [...container.querySelectorAll('[role="alert"]')].map(
        (a) => a.textContent
      )
    ).toEqual([
      "Can't reach the gate on the host.",
      "Could not read the models from the gate.",
    ])
    for (const button of container.querySelectorAll("button")) button.click()
    expect(retry).toHaveBeenCalledTimes(2)
  })
})

describe("AdminShell", () => {
  it("links the four tabs and marks the current page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ expiresAt: null }))
    )
    await act(async () => {
      root.render(<AdminShell>page</AdminShell>)
    })
    const links = [...container.querySelectorAll("nav a")]
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Status", "/admin"],
      ["Connectors", "/admin/connectors"],
      ["Model", "/admin/model"],
      ["Devices", "/admin/devices"],
    ])
    expect(
      links
        .filter((a) => a.getAttribute("aria-current") === "page")
        .map((a) => a.textContent)
    ).toEqual(["Model"])
    expect(container.textContent).not.toContain("Elevated ·")
  })

  it("counts the step-up down in the header while it lasts", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-11-07T10:00:00.000Z"))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ expiresAt: "2026-11-07T10:04:12.000Z" })
      )
    )
    pathname = "/admin"
    await act(async () => {
      root.render(<AdminShell>page</AdminShell>)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(container.textContent).toContain("Elevated · 4:12")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(container.textContent).toContain("Elevated · 4:10")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250_000)
    })
    expect(container.textContent).not.toContain("Elevated ·")
  })
})
