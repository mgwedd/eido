// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { performSignOut } from "@/lib/auth/sign-out"
import { TRANSACTIONS_CACHE_KEY } from "@/lib/transactions"

describe("performSignOut", () => {
  const originalLocation = window.location

  beforeEach(() => {
    // Mock window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "http://localhost:3000/today" },
    })
  })

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("calls POST /api/gate/auth/logout and returns to /unlock in passkey mode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await performSignOut()

    expect(fetchMock).toHaveBeenCalledWith("/api/gate/auth/logout", {
      method: "POST",
      cache: "no-store",
    })
    expect(window.location.href).toBe("/unlock")
  })

  it("navigates to /unlock even if gate logout fetch throws an error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"))
    vi.stubGlobal("fetch", fetchMock)

    await performSignOut()

    expect(fetchMock).toHaveBeenCalledWith("/api/gate/auth/logout", {
      method: "POST",
      cache: "no-store",
    })
    expect(window.location.href).toBe("/unlock")
  })

  it("navigates to /auth/logout when Auth0 is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH0_ENABLED", "true")
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await performSignOut()

    expect(window.location.href).toBe("/auth/logout")
  })

  it("clears the cached transactions even when the gate logout fails", async () => {
    window.localStorage.setItem(TRANSACTIONS_CACHE_KEY, "{}")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))

    await performSignOut()

    expect(window.localStorage.getItem(TRANSACTIONS_CACHE_KEY)).toBeNull()
  })
})
