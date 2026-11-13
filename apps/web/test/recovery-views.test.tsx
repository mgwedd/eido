// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- stubs of promise-returning browser APIs */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { RecoverView } from "@/components/recover-view"
import { RecoveryBanner } from "@/components/recovery-banner"
import { RecoveryCancelView } from "@/components/recovery-cancel-view"
import { RecoveryKeyCard } from "@/components/recovery-key-card"
import {
  KEY,
  bodyText,
  NOW,
  REPLACEMENT_KEY,
  preparedCancel,
  recoveryFixtures,
} from "./fixtures/recovery"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const replace = vi.fn()
let pathname = "/"
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
}))
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: string
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

class FakeAttestationResponse {
  clientDataJSON = new Uint8Array([2]).buffer
  getAuthenticatorData = () => new Uint8Array([1]).buffer
  getPublicKey = () => new Uint8Array([4]).buffer
  getPublicKeyAlgorithm = () => -7
}
class FakeAssertionResponse {
  clientDataJSON = new Uint8Array([5]).buffer
  authenticatorData = new Uint8Array([6]).buffer
  signature = new Uint8Array([7]).buffer
}
class FakeCredential {
  rawId = new Uint8Array([9]).buffer
  response: unknown
  constructor(response: unknown) {
    this.response = response
  }
}

const OPTIONS = {
  challenge: "A".repeat(43),
  rpId: "eido.tail1234.ts.net",
  expiresAt: "2030-01-15T12:10:00.000Z",
}
const SIGNED_OUT = { enrolled: true, revoked: false, sessionExpiresAt: null }
const SIGNED_IN = {
  enrolled: true,
  revoked: false,
  sessionExpiresAt: "2030-01-15T20:00:00.000Z",
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

let container: HTMLElement
let root: Root
type Routes = Record<string, () => Response>

function setup(
  routes: Routes,
  webauthn: { get?: () => Promise<unknown> } = {}
) {
  vi.stubGlobal("location", {
    ...window.location,
    hostname: "eido.tail1234.ts.net",
  })
  vi.stubGlobal("PublicKeyCredential", FakeCredential)
  vi.stubGlobal("AuthenticatorAttestationResponse", FakeAttestationResponse)
  vi.stubGlobal("AuthenticatorAssertionResponse", FakeAssertionResponse)
  vi.stubGlobal("navigator", {
    credentials: {
      create: vi.fn(
        async () => new FakeCredential(new FakeAttestationResponse())
      ),
      get: vi.fn(
        webauthn.get ??
          (async () => new FakeCredential(new FakeAssertionResponse()))
      ),
    },
  })
  const fetchStub = vi.fn<
    (url: string, init?: RequestInit) => Promise<Response>
  >(async (url) => {
    const route = routes[url.replace("/api/gate", "")]
    if (route === undefined) throw new Error(`unexpected ${url}`)
    return route()
  })
  vi.stubGlobal("fetch", fetchStub)
  return fetchStub
}

async function render(ui: React.ReactNode) {
  await act(async () => {
    root.render(ui)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
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

async function click(label: string) {
  const target = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label)
  )
  if (target === undefined) throw new Error(`no button "${label}"`)
  await act(async () => {
    target.click()
    await new Promise((resolve) => setTimeout(resolve, 25))
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

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label)
  )
const status = () =>
  container.querySelector('[role="status"]')?.textContent ?? null
const alertText = () =>
  container.querySelector('[role="alert"]')?.textContent ?? null

beforeEach(() => {
  replace.mockClear()
  pathname = "/"
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("RecoveryKeyCard", () => {
  const onContinue = vi.fn()
  const card = () => (
    <RecoveryKeyCard
      recoveryKey={KEY}
      overline="Set up this device"
      onContinue={onContinue}
    />
  )

  beforeEach(() => onContinue.mockClear())

  it("shows the key in two lines and keeps Continue disabled until the owner confirms", async () => {
    await render(card())
    const group = container.querySelector('[role="group"]')
    expect(group?.textContent).toContain("ABCD-EFGH-JKMN-PQRS")
    expect(group?.textContent).toContain("TVWX-YZ01-2345-6789")
    expect(button("Continue")?.disabled).toBe(true)
    await act(async () => {
      container.querySelector("label")?.click()
    })
    expect(button("Continue")?.disabled).toBe(false)
    await click("Continue")
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it("copies the key and says so", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(
      async () => undefined
    )
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    await render(card())
    await click("Copy key")
    expect(writeText).toHaveBeenCalledWith(KEY)
    expect(status()).toBe("Copied")
  })

  it("points to the file when the browser refuses the clipboard", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new DOMException("blocked", "NotAllowedError")
        },
      },
    })
    await render(card())
    await click("Copy key")
    expect(status()).toBe(
      "This browser did not allow copying. Save the key as a file instead."
    )
  })

  it("saves the key as eido-recovery-key.txt holding the key and nothing else", async () => {
    let blob: Blob | undefined
    const createObjectURL = vi.fn((made: Blob) => {
      blob = made
      return "blob:eido-test"
    })
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL })
    let download: string | undefined
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      download = this.download
    })
    await render(card())
    await click("Save as file")
    expect(download).toBe("eido-recovery-key.txt")
    expect(await blob?.text()).toBe(`${KEY}\n`)
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:eido-test")
  })
})

describe("RecoverView", () => {
  const start = (response: () => Response): Routes => ({
    "/passkey/status": () => json(200, SIGNED_OUT),
    "/passkey/recover/start": response,
  })

  it("starts a recovery with the typed key and shows the delay and its end", async () => {
    const fetchStub = setup(start(() => json(200, recoveryFixtures.pending)))
    await render(<RecoverView />)
    expect(button("Start recovery")?.disabled).toBe(true)
    await type(KEY)
    await submit()
    const body = JSON.parse(
      bodyText(
        fetchStub.mock.calls.find(([url]) =>
          url.endsWith("/recover/start")
        )?.[1]
      )
    ) as { recoveryKey: string }
    expect(body.recoveryKey).toBe(KEY)
    expect(container.textContent).toContain("Ready in23h 41m")
    expect(container.textContent).toContain("Started 00:19 ago")
    expect(container.textContent).toContain("Expires")
    expect(button("Create new passkey")?.disabled).toBe(true)
    expect(status()).toBe("")
  })

  it("keeps the key out of storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    setup(start(() => json(200, recoveryFixtures.pending)))
    await render(<RecoverView />)
    await type(KEY)
    await submit()
    expect(setItem).not.toHaveBeenCalled()
  })

  it("says the key was not accepted and leaves it in the field to correct", async () => {
    setup(start(() => json(403, { error: "verification_failed" })))
    await render(<RecoverView />)
    await type(KEY)
    await submit()
    expect(alertText()).toBe("Key not accepted. Check the key and try again.")
    expect(container.querySelector("input")?.value).toBe(KEY)
    expect(button("Start recovery")?.disabled).toBe(false)
  })

  it("disables Start while the gate is rate limiting", async () => {
    setup(start(() => json(429, { error: "busy" })))
    await render(<RecoverView />)
    await type(KEY)
    await submit()
    expect(alertText()).toBe("Too many tries. Wait a few minutes.")
    expect(button("Start recovery")?.disabled).toBe(true)
  })

  it("says when the Mac cannot be reached", async () => {
    setup(
      start(() => {
        throw new TypeError("network")
      })
    )
    await render(<RecoverView />)
    await type(KEY)
    await submit()
    expect(alertText()).toBe("Cannot reach the Mac.")
  })

  it("completes a matured recovery with a new passkey and shows the replacement key once", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    setup({
      "/passkey/status": () =>
        json(200, { ...SIGNED_OUT, recovery: recoveryFixtures.matured }),
      "/passkey/recover/options": () => json(200, OPTIONS),
      "/passkey/recover/complete": () =>
        json(200, {
          expiresAt: "2030-01-16T00:00:00.000Z",
          recoveryKey: REPLACEMENT_KEY,
        }),
    })
    await render(<RecoverView />)
    expect(status()).toBe(
      "The wait is over. Create a new passkey on this phone."
    )
    // The key is not kept across a reload, so it is asked for again.
    expect(button("Create new passkey")?.disabled).toBe(true)
    await type(KEY)
    await click("Create new passkey")
    expect(container.querySelector('[role="group"]')?.textContent).toContain(
      "9876-5432-1ZYX-WVTS"
    )
    expect(container.textContent).not.toContain("ABCD")
    expect(replace).not.toHaveBeenCalled()
    await act(async () => {
      container.querySelector("label")?.click()
    })
    await click("Continue")
    expect(replace).toHaveBeenCalledWith("/")
    expect(setItem).not.toHaveBeenCalled()
  })

  it("offers a fresh start once the recovery ran out", async () => {
    setup({
      "/passkey/status": () =>
        json(200, { ...SIGNED_OUT, recovery: recoveryFixtures.expired }),
    })
    await render(<RecoverView />)
    expect(status()).toBe("This recovery ran out. Start again with your key.")
    expect(button("Create new passkey")).toBeUndefined()
    await click("Start again")
    expect(container.querySelector("input")).not.toBeNull()
    expect(status()).toBe("")
  })

  it("says the recovery was cancelled when the gate refuses and no recovery stands", async () => {
    let calls = 0
    setup({
      "/passkey/status": () =>
        json(
          200,
          calls++ === 0
            ? { ...SIGNED_OUT, recovery: recoveryFixtures.matured }
            : SIGNED_OUT
        ),
      "/passkey/recover/options": () =>
        json(403, { error: "verification_failed" }),
    })
    await render(<RecoverView />)
    await type(KEY)
    await click("Create new passkey")
    expect(status()).toBe("Recovery cancelled.")
    expect(button("Start again")).toBeDefined()
  })
})

describe("RecoveryCancelView", () => {
  it("cancels a pending recovery with the passkey and shows the replacement key once", async () => {
    const fetchStub = setup({
      "/passkey/status": () =>
        json(200, { ...SIGNED_IN, recovery: recoveryFixtures.pending }),
      "/passkey/recover/cancel/prepare": () => json(200, preparedCancel()),
      "/passkey/recover/cancel": () =>
        json(200, { recoveryKey: REPLACEMENT_KEY }),
    })
    await render(<RecoveryCancelView />)
    expect(container.textContent).toContain(
      "Someone entered your recovery key."
    )
    expect(container.textContent).toContain("Ready in23h 41m")
    await click("Cancel recovery")
    const cancelCall = fetchStub.mock.calls.find(([url]) =>
      url.endsWith("/recover/cancel")
    )
    expect(JSON.parse(bodyText(cancelCall?.[1]))).toMatchObject({
      approval: { id: "cancel-1" },
    })
    expect(container.textContent).toContain("Recovery cancelled")
    expect(container.querySelector('[role="group"]')?.textContent).toContain(
      "9876-5432-1ZYX-WVTS"
    )
  })

  it("keeps the recovery on screen when the gate refuses the cancel", async () => {
    setup({
      "/passkey/status": () =>
        json(200, { ...SIGNED_IN, recovery: recoveryFixtures.pending }),
      "/passkey/recover/cancel/prepare": () => json(200, preparedCancel()),
      "/passkey/recover/cancel": () =>
        json(403, { error: "verification_failed" }),
    })
    await render(<RecoveryCancelView />)
    await click("Cancel recovery")
    expect(alertText()).toBe("The gate did not accept the cancel. Try again.")
    expect(button("Cancel recovery")?.disabled).toBe(false)
  })

  it("says nothing is pending when there is no recovery", async () => {
    setup({ "/passkey/status": () => json(200, SIGNED_IN) })
    await render(<RecoveryCancelView />)
    expect(status()).toBe("No recovery is pending.")
    expect(button("Cancel recovery")).toBeUndefined()
  })
})

describe("RecoveryBanner", () => {
  const withRecovery = (recovery: unknown): Routes => ({
    "/passkey/status": () => json(200, { ...SIGNED_IN, recovery }),
  })

  it("links a pending recovery to the page that cancels it", async () => {
    setup(withRecovery(recoveryFixtures.pending))
    await render(<RecoveryBanner />)
    expect(alertText()).toContain("Someone started a passkey recovery.")
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/settings/recovery"
    )
  })

  it("says nothing without a pending recovery or once it ran out", async () => {
    setup(withRecovery(undefined))
    await render(<RecoveryBanner />)
    expect(container.textContent).toBe("")
    setup(withRecovery(recoveryFixtures.expired))
    await render(<RecoveryBanner />)
    expect(container.textContent).toBe("")
  })

  it("stays out of the way on the recovery page itself", async () => {
    pathname = "/settings/recovery"
    setup(withRecovery(recoveryFixtures.pending))
    await render(<RecoveryBanner />)
    expect(container.textContent).toBe("")
  })
})
