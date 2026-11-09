// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminConnectorsView } from "../components/admin-connectors-view"
import { AdminProvider } from "../components/admin-step-up"
import { FAKE_ASSERTION, FakeCredential, stubPasskey } from "./admin-webauthn"
import {
  FLOW,
  GOOGLE_URL,
  PIN,
  bridgePrepared,
  drive,
  fakeGate,
  gmail,
  gmailWithAccount,
  googlePrepared,
  json,
  protonMail,
  protonWithPassword,
  sealedHealth,
  type Call,
} from "./fixtures/admin-connectors"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const router = { push: vi.fn() }
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/connectors",
}))

const FUTURE = "2099-01-01T00:00:00.000Z"
const SECRET = "typed-secret-77"
const ROOT = {
  id: "docs",
  root: { path: "/x", dev: "1", ino: "2", trashDir: ".t" },
}

let container: HTMLElement
let root: Root
const navigate = vi.fn()

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  navigate.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", "/")
})

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) {
    await act(async () => {
      await tick(10)
    })
  }
}

const prompting = () => document.body.textContent?.includes("Sign this change")

/** Waits for the sign prompt, signs, and waits for it to close and the outcome to land. */
async function sign() {
  await waitFor(() => prompting() === true)
  await click(document.body, "Sign with passkey")
  await waitFor(() => prompting() !== true)
  await settle()
}

async function settle() {
  await act(async () => {
    await tick(10)
  })
}

type Extra = Record<string, (call: Call) => Response | Promise<Response>>

function stubGate(
  connectors: unknown[],
  extra: Extra = {},
  roots: unknown[] = [ROOT, ROOT, ROOT]
) {
  const gate = fakeGate({
    "GET /connector-settings": () => json(200, { connectors }),
    "GET /file-roots": () => json(200, { roots }),
    "GET /auth/step-up": () => json(200, { expiresAt: FUTURE }),
    ...extra,
  })
  vi.stubGlobal("fetch", gate.fetch)
  stubPasskey(() => Promise.resolve(new FakeCredential()))
  return gate
}

async function render() {
  act(() => {
    root.render(
      <AdminProvider>
        <AdminConnectorsView navigate={navigate} />
      </AdminProvider>
    )
  })
  await settle()
}

const card = (title: string) => {
  const found = container.querySelector(`[aria-label="${title}"]`)
  if (found === null) throw new Error(`no card ${title}`)
  return found as HTMLElement
}

function button(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name
  )
  if (found === undefined) throw new Error(`no button ${name}`)
  return found
}

async function click(scope: ParentNode, name: string) {
  await act(async () => {
    button(scope, name).click()
    await tick(10)
  })
}

const input = (scope: ParentNode, label: string) => {
  const labelled = [...scope.querySelectorAll("label")].find(
    (l) => l.textContent === label
  )
  const found =
    labelled &&
    scope.querySelector<HTMLInputElement>(`#${CSS.escape(labelled.htmlFor)}`)
  if (!found) throw new Error(`no field ${label}`)
  return found
}

const submit = async (scope: ParentNode) => {
  await act(async () => {
    scope
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await tick(10)
  })
}

function typeInto(field: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )
  act(() => {
    descriptor?.set?.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const countOf = (gate: { calls: Call[] }, path: string) =>
  gate.calls.filter((c) => c.path === path).length

describe("reading", () => {
  it("shows each card's state from the gate's connector list and the folder count", async () => {
    const gate = stubGate([gmail, protonMail])
    await render()
    expect(gate.calls.map((c) => c.path)).toContain("/connector-settings")
    expect(card("Gmail").textContent).toContain("Connected")
    expect(card("Gmail").textContent).toContain("gmail.readonly, gmail.modify")
    expect(button(card("Gmail"), "Reconnect")).toBeTruthy()
    expect(button(card("Gmail"), "Remove")).toBeTruthy()
    expect(card("Drive").textContent).toContain("Not connected")
    expect(button(card("Drive"), "Connect with Google")).toBeTruthy()
    expect(() => button(card("Drive"), "Remove")).toThrow()
    expect(card("Proton (Bridge)").textContent).toContain("Connected")
    expect(card("Proton (Bridge)").textContent).toContain(
      "Changing the pin deletes the stored Bridge password."
    )
    expect(card("SimpleFIN").textContent).toContain("Wave 1")
    expect(card("SimpleFIN").textContent).toContain("Not connected")
    expect(card("Local folders").textContent).toContain("3 folders")
    expect(card("Local folders").querySelector("a")?.getAttribute("href")).toBe(
      "/settings/folders/edit"
    )
    expect(card("Gmail").textContent).not.toContain("owner@example.invalid")
    expect(card("Proton (Bridge)").textContent).not.toContain("Password stored")
  })

  it("shows Bridge Password stored and Gmail account email when reported (#672)", async () => {
    stubGate([gmailWithAccount, protonWithPassword])
    await render()
    expect(card("Gmail").textContent).toContain("owner@example.invalid")
    expect(card("Proton (Bridge)").textContent).toContain("Password stored")
  })

  it("leaves the folder count out when it cannot be read", async () => {
    stubGate([gmail], { "GET /file-roots": () => json(500, {}) })
    await render()
    expect(card("Local folders").textContent).toBe(
      "Local foldersAllowed folders"
    )
  })

  it("says so when the gate sends an unusable answer, and Retry reads again", async () => {
    let healthy = false
    const gate = stubGate([], {
      "GET /connector-settings": () =>
        healthy ? json(200, { connectors: [gmail] }) : json(500, {}),
    })
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not read the connectors from the gate."
    )
    healthy = true
    await click(container, "Retry")
    expect(countOf(gate, "/connector-settings")).toBe(2)
    expect(card("Gmail").textContent).toContain("Connected")
  })

  it("shows the unreachable alert when fetch fails", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("network")))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Can't reach the gate on the host."
    )
  })

  it("announces a landing from Google and leaves the address alone", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/connectors?google=drive&connected=healthy"
    )
    stubGate([drive])
    await render()
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Drive connected. Health: healthy."
    )
    expect(window.location.search).toBe("?google=drive&connected=healthy")
  })

  it("announces a failed landing as an alert", async () => {
    window.history.replaceState(null, "", "/admin/connectors?error=expired")
    stubGate([])
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The Google sign-in expired or was already used. Start it again."
    )
  })
})

describe("remove", () => {
  it("asks first, and Cancel sends nothing", async () => {
    const gate = stubGate([gmail])
    await render()
    await click(card("Gmail"), "Remove")
    expect(document.body.textContent).toContain("Remove Gmail?")
    expect(document.body.textContent).toContain(
      "Eido deletes Gmail's tokens from the vault. Mail already indexed stays."
    )
    await click(document.body, "Cancel")
    expect(gate.calls.some((c) => c.path.endsWith("/remove"))).toBe(false)
    expect(document.body.textContent).not.toContain("Remove Gmail?")
  })

  it("posts the remove, says so and reads the list again", async () => {
    const gate = stubGate([gmail], {
      "POST /admin/connectors/gmail/remove": () =>
        json(200, { connector: "gmail" }),
    })
    await render()
    await click(card("Gmail"), "Remove")
    await click(document.body, "Remove Gmail")
    await settle()
    expect(
      gate.calls.filter((c) => c.method === "POST").map((c) => c.path)
    ).toEqual(["/admin/connectors/gmail/remove"])
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Gmail removed."
    )
    expect(countOf(gate, "/connector-settings")).toBe(2)
  })

  it("says why when the gate refuses", async () => {
    stubGate([gmail], {
      "POST /admin/connectors/gmail/remove": () =>
        json(503, { code: "unavailable", message: "x" }),
    })
    await render()
    await click(card("Gmail"), "Remove")
    await click(document.body, "Remove Gmail")
    await settle()
    await waitFor(() => container.querySelector('[role="alert"]') !== null)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not remove Gmail: the gate cannot do this right now."
    )
  })

  it("uses a bottom sheet on a phone", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    stubGate([gmail])
    await render()
    await click(card("Gmail"), "Remove")
    expect(
      document.body.querySelector('[data-slot="sheet-content"]')
    ).not.toBeNull()
    expect(document.body.textContent).toContain("Remove Gmail?")
  })
})

describe("Google sign-in", () => {
  const prepareRoute = (stored: boolean) => ({
    "POST /admin/connectors/google/prepare": () =>
      json(200, {
        approval: googlePrepared("drive", "drive", "read"),
        clientSecretStored: stored,
      }),
    "POST /admin/connectors/google/start": () =>
      json(200, { authorizationUrl: GOOGLE_URL, flow: FLOW }),
  })

  it("signs and sends the browser to Google when the vault holds the client secret", async () => {
    const gate = stubGate([], prepareRoute(true))
    await render()
    await click(card("Drive"), "Connect with Google")
    await waitFor(() => prompting() === true)
    expect(document.body.textContent).toContain("Sign this change")
    await sign()
    const start = gate.calls.find(
      (c) => c.path === "/admin/connectors/google/start"
    )
    expect(start?.body).toEqual({
      target: "drive",
      approval: {
        id: "control-1",
        nonce: "N".repeat(43),
        assertion: FAKE_ASSERTION,
      },
    })
    expect(navigate).toHaveBeenCalledWith(GOOGLE_URL)
  })

  it("asks for the client secret first when the vault has none, and clears it after", async () => {
    const gate = stubGate([], prepareRoute(false))
    await render()
    await click(card("Drive"), "Connect with Google")
    await waitFor(
      () => card("Drive").textContent?.includes("Google client secret") === true
    )
    expect(gate.calls.some((c) => c.path.endsWith("/start"))).toBe(false)
    const field = input(card("Drive"), "Google client secret")
    field.value = SECRET
    await submit(card("Drive"))
    await sign()
    const start = gate.calls.find(
      (c) => c.path === "/admin/connectors/google/start"
    )
    expect(start?.body).toMatchObject({ target: "drive", clientSecret: SECRET })
    expect(field.value).toBe("")
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(navigate).toHaveBeenCalledWith(GOOGLE_URL)
  })

  it("Cancel drops the secret prompt without signing", async () => {
    stubGate([], prepareRoute(false))
    await render()
    await click(card("Drive"), "Connect with Google")
    await waitFor(
      () => card("Drive").textContent?.includes("Google client secret") === true
    )
    await click(card("Drive"), "Cancel")
    expect(button(card("Drive"), "Connect with Google")).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("says why when the gate cannot start the sign-in", async () => {
    stubGate([], {
      "POST /admin/connectors/google/prepare": () =>
        json(503, { code: "unavailable", message: "x" }),
    })
    await render()
    await click(card("Drive"), "Connect with Google")
    await waitFor(() => card("Drive").querySelector('[role="alert"]') !== null)
    expect(card("Drive").querySelector('[role="alert"]')?.textContent).toBe(
      "Could not start Drive: the gate cannot do this right now."
    )
  })

  it("says why when the signature is refused", async () => {
    stubGate([], {
      ...prepareRoute(true),
      "POST /admin/connectors/google/start": () =>
        json(403, { code: "verification_failed", message: "x" }),
    })
    await render()
    await click(card("Drive"), "Connect with Google")
    await sign()
    await waitFor(() => card("Drive").querySelector('[role="alert"]') !== null)
    expect(card("Drive").querySelector('[role="alert"]')?.textContent).toBe(
      "Could not connect Drive: the passkey signature was refused."
    )
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe("Proton Bridge", () => {
  const routes = {
    "POST /admin/secrets/bridge/prepare": () => json(200, bridgePrepared(PIN)),
    "POST /admin/secrets/bridge": () => json(201, sealedHealth),
  }

  it("seals the password under the pin, clears the field and reads the list again", async () => {
    const gate = stubGate([protonMail], routes)
    await render()
    const bridge = card("Proton (Bridge)")
    const pin = input(bridge, "Certificate pin (SHA-256)")
    const password = input(bridge, "Bridge password")
    typeInto(pin, PIN)
    password.value = SECRET
    await click(bridge, "Seal and connect")
    await waitFor(() => prompting() === true)
    expect(document.body.textContent).toContain("Sign this change")
    expect(document.body.textContent).toContain("ab12 ab12")
    expect(document.body.textContent).not.toContain(SECRET)
    await sign()
    const sent = gate.calls.find((c) => c.path === "/admin/secrets/bridge")
    expect(sent?.body).toMatchObject({
      certificateSha256: PIN,
      password: SECRET,
    })
    expect(password.value).toBe("")
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(bridge.querySelector('[role="status"]')?.textContent).toBe(
      "Sealed in the gate's vault. The field is cleared."
    )
    expect(countOf(gate, "/connector-settings")).toBe(2)
  })

  it("refuses a pin that is not 64 hex characters without calling the gate", async () => {
    const gate = stubGate([], routes)
    await render()
    const bridge = card("Proton (Bridge)")
    input(bridge, "Bridge password").value = SECRET
    await submit(bridge)
    expect(bridge.querySelector('[role="alert"]')?.textContent).toBe(
      "The certificate pin must be 64 hex characters (SHA-256)."
    )
    expect(gate.calls.some((c) => c.method === "POST")).toBe(false)
    expect(input(bridge, "Bridge password").value).toBe(SECRET)
  })

  it("Change pin signs the pin alone and says to restart", async () => {
    const gate = stubGate([], {
      "POST /admin/secrets/bridge-pin/prepare": () =>
        json(200, {
          ...bridgePrepared(PIN),
          target: "connector_pin:proton-mail",
        }),
    })
    await render()
    // The fake prepares the wrong ceremony for the pin route, so the device must refuse it.
    const bridge = card("Proton (Bridge)")
    const pin = input(bridge, "Certificate pin (SHA-256)")
    typeInto(pin, PIN)
    await click(bridge, "Change pin")
    await waitFor(() => bridge.querySelector('[role="alert"]') !== null)
    expect(bridge.querySelector('[role="alert"]')?.textContent).toBe(
      "Not saved: the gate prepared a different change than asked, so nothing was signed. The field is cleared; type it again."
    )
    expect(gate.calls.some((c) => c.path === "/admin/secrets/bridge-pin")).toBe(
      false
    )
  })
})

describe("SimpleFIN", () => {
  it("seals the setup token through the signed route", async () => {
    const { simplefinPrepared } = await import("./fixtures/admin-connectors")
    const gate = stubGate([], {
      "POST /admin/secrets/simplefin/prepare": () =>
        json(200, simplefinPrepared),
      "POST /admin/secrets/simplefin": () => json(201, sealedHealth),
    })
    await render()
    const simplefin = card("SimpleFIN")
    input(simplefin, "Setup token").value = SECRET
    await submit(simplefin)
    await sign()
    const sent = gate.calls.find((c) => c.path === "/admin/secrets/simplefin")
    expect(sent?.body).toMatchObject({ setupToken: SECRET })
    expect(input(simplefin, "Setup token").value).toBe("")
  })
})
