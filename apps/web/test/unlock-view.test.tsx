// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- fetch and navigator.credentials.get return promises, so their stubs are async functions with nothing to await */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { UnlockView } from "@/components/unlock-view"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const replace = vi.fn()
const router = { replace } // stable, like the real router
vi.mock("next/navigation", () => ({ useRouter: () => router }))

class FakeAssertionResponse {
  authenticatorData = new Uint8Array([1]).buffer
  clientDataJSON = new Uint8Array([2]).buffer
  signature = new Uint8Array([3]).buffer
}
class FakeCredential {
  rawId = new Uint8Array([9]).buffer
  response: unknown = new FakeAssertionResponse()
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const options = {
  challenge: "A".repeat(43),
  rpId: "eido.tail1234.ts.net",
  expiresAt: "2026-10-27T10:00:00.000Z",
}

let container: HTMLElement
let root: Root

function setup(opts: {
  hostname?: string
  webauthn?: boolean
  status?: unknown
  get?: () => Promise<unknown>
  login?: () => Response
}) {
  vi.stubGlobal("location", {
    ...window.location,
    hostname: opts.hostname ?? "eido.tail1234.ts.net",
  })
  if (opts.webauthn !== false) {
    vi.stubGlobal("PublicKeyCredential", FakeCredential)
    vi.stubGlobal("AuthenticatorAssertionResponse", FakeAssertionResponse)
    vi.stubGlobal("navigator", {
      credentials: {
        get: vi.fn(opts.get ?? (async () => new FakeCredential())),
      },
    })
  } else {
    vi.stubGlobal("PublicKeyCredential", undefined)
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/passkey/status"))
        return json(
          200,
          opts.status ?? { enrolled: true, sessionExpiresAt: null }
        )
      if (url.endsWith("/auth/login/options")) return json(200, options)
      if (url.endsWith("/auth/login"))
        return (
          opts.login?.() ?? json(200, { expiresAt: "2026-10-27T22:00:00Z" })
        )
      throw new Error(`unexpected ${url}`)
    })
  )
}

async function render(next = "/queue", expired = false) {
  await act(async () => {
    root.render(<UnlockView next={next} expired={expired} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function button(): HTMLButtonElement | null {
  return container.querySelector("button")
}

async function press() {
  await act(async () => {
    button()?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  replace.mockClear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("UnlockView", () => {
  it("unlocks with the button and goes to the requested page", async () => {
    setup({})
    await render()
    expect(button()?.textContent).toContain("Unlock with Face ID")
    expect(replace).not.toHaveBeenCalled()
    await press()
    expect(replace).toHaveBeenCalledWith("/queue")
  })

  it("says the session expired and does not skip ahead on a stale live session", async () => {
    setup({
      status: { enrolled: true, sessionExpiresAt: "2026-10-27T22:00:00.000Z" },
    })
    await render("/queue", true)
    expect(replace).not.toHaveBeenCalled()
    expect(container.querySelector("[role=status]")?.textContent).toBe(
      "Your session expired. Unlock to continue."
    )
  })

  it("shows the host the passkey is used on", async () => {
    setup({})
    await render()
    expect(container.textContent).toContain("eido.tail1234.ts.net")
  })

  it("skips straight to the page when a session is already live", async () => {
    setup({
      status: { enrolled: true, sessionExpiresAt: "2026-10-27T22:00:00.000Z" },
    })
    await render("/")
    expect(replace).toHaveBeenCalledWith("/")
  })

  it("offers no unlock when this device has no passkey", async () => {
    setup({ status: { enrolled: false, sessionExpiresAt: null } })
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This device has no passkey yet."
    )
    expect(button()).toBeNull()
  })

  it("stays locked and lets the user try again after Face ID is cancelled", async () => {
    setup({
      get: async () => {
        throw new DOMException("cancelled", "NotAllowedError")
      },
    })
    await render()
    await press()
    expect(replace).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Face ID was cancelled. Eido is still locked."
    )
    expect(button()?.disabled).toBe(false)
  })

  it("shows the gate's refusal and stays locked", async () => {
    setup({
      login: () =>
        json(401, { code: "verification_failed", message: "Passkey refused." }),
    })
    await render()
    await press()
    expect(replace).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Passkey refused."
    )
  })

  it("does not ask the gate anything from the wrong address", async () => {
    setup({ hostname: "192.168.1.5" })
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Open Eido from its Tailscale address to unlock."
    )
    expect(button()).toBeNull()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("explains a browser without passkeys", async () => {
    setup({ webauthn: false })
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This browser can't use passkeys."
    )
  })

  it("retries the check after the gate fails", async () => {
    setup({ status: { nope: 1 } })
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't check this device with the gate."
    )
    setup({})
    await press()
    expect(button()?.textContent).toContain("Unlock with Face ID")
  })
})
