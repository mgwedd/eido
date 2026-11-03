// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- stubs of promise-returning browser APIs */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { EnrollView } from "@/components/enroll-view"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const replace = vi.fn()
const router = { replace }
vi.mock("next/navigation", () => ({ useRouter: () => router }))

class FakeAttestationResponse {
  clientDataJSON = new Uint8Array([2]).buffer
  getAuthenticatorData = () => new Uint8Array([1]).buffer
  getPublicKey = () => new Uint8Array([4]).buffer
  getPublicKeyAlgorithm = () => -7
}
class FakeCredential {
  rawId = new Uint8Array([9]).buffer
  response: unknown = new FakeAttestationResponse()
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

let container: HTMLElement
let root: Root

function setup(opts: {
  hostname?: string
  webauthn?: boolean
  status?: unknown
  create?: () => Promise<unknown>
  enrol?: () => Response
}) {
  vi.stubGlobal("location", {
    ...window.location,
    hostname: opts.hostname ?? "eido.tail1234.ts.net",
  })
  if (opts.webauthn !== false) {
    vi.stubGlobal("PublicKeyCredential", FakeCredential)
    vi.stubGlobal("AuthenticatorAttestationResponse", FakeAttestationResponse)
    vi.stubGlobal("navigator", {
      credentials: {
        create: vi.fn(opts.create ?? (async () => new FakeCredential())),
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
          opts.status ?? { enrolled: false, sessionExpiresAt: null }
        )
      if (url.endsWith("/passkey/enroll/options"))
        return json(200, {
          challenge: "A".repeat(43),
          rpId: "eido.tail1234.ts.net",
          expiresAt: "2026-10-27T10:00:00.000Z",
        })
      if (url.endsWith("/passkey/enroll"))
        return (
          opts.enrol?.() ?? json(200, { expiresAt: "2026-10-27T22:00:00Z" })
        )
      if (url.endsWith("/passkeys"))
        return json(200, {
          passkeys: [
            {
              fingerprint: "b".repeat(64),
              createdAt: "2026-02-02T12:00:00.000Z",
              revokedAt: null,
              current: true,
            },
          ],
        })
      throw new Error(`unexpected ${url}`)
    })
  )
}

async function render(next = "/queue") {
  await act(async () => {
    root.render(<EnrollView next={next} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function button(): HTMLButtonElement | null {
  return container.querySelector("button")
}

async function type(value: string) {
  const input = container.querySelector("input")
  if (input === null) throw new Error("no input")
  await act(async () => {
    // React tracks the value through the instance, so the prototype setter is the way to change it from a test.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with .call on the input
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function submit() {
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const alertText = () =>
  container.querySelector('[role="alert"]')?.textContent ?? null

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

describe("EnrollView", () => {
  it("has one primary button, disabled until a code is typed", async () => {
    setup({})
    await render()
    expect(container.querySelectorAll("button")).toHaveLength(1)
    expect(button()?.textContent).toContain("Create passkey")
    expect(button()?.disabled).toBe(true)
    await type("ABCD")
    expect(button()?.disabled).toBe(false)
  })

  it("enrols on submit (Enter) and goes to the requested page", async () => {
    setup({})
    await render("/queue")
    await type("ABCD-EFGH")
    await submit()
    expect(replace).toHaveBeenCalledWith("/queue")
  })

  it("does not submit an empty code", async () => {
    setup({})
    await render()
    await submit()
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1) // the status check only
  })

  it("allows a retry after the passkey prompt is cancelled and shows no partial state", async () => {
    setup({
      create: async () => {
        throw new DOMException("cancelled", "NotAllowedError")
      },
    })
    await render()
    await type("ABCD")
    await submit()
    expect(replace).not.toHaveBeenCalled()
    expect(alertText()).toBe(
      "The passkey prompt was cancelled. Nothing was saved. You can try again."
    )
    expect(button()?.disabled).toBe(false)
  })

  it("shows the gate's error and does not retry on its own", async () => {
    setup({
      enrol: () =>
        json(403, { code: "verification_failed", message: "Passkey exists." }),
    })
    await render()
    await type("ABCD")
    await submit()
    expect(alertText()).toBe("Passkey exists.")
    const enrolCalls = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([url]) => typeof url === "string" && url.endsWith("/passkey/enroll")
      )
    expect(enrolCalls).toHaveLength(1)
  })

  it("shows an enrolled phone with its creation time and a way on", async () => {
    setup({
      status: { enrolled: true, sessionExpiresAt: "2026-10-27T22:00:00.000Z" },
    })
    await render("/queue")
    expect(container.querySelector("[role=status]")?.textContent).toBe(
      "This phone can now approve actions."
    )
    expect(container.textContent).toContain("Passkey created")
    expect(container.textContent).toContain("revoked from the Mac")
    expect(container.querySelector("input")).toBeNull()
  })

  it("does not ask the gate anything from the wrong address", async () => {
    setup({ hostname: "192.168.1.5" })
    await render()
    expect(alertText()).toContain("Open Eido from its Tailscale address")
    expect(container.querySelector("input")).toBeNull()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("explains a browser without passkeys", async () => {
    setup({ webauthn: false })
    await render()
    expect(alertText()).toContain("This browser cannot create passkeys.")
  })
})
