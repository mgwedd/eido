// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"

import { AdminSecretField } from "../components/admin-secret-field"
import { sealSimpleFin, type Signer } from "../lib/admin/connectors"
import { FakeCredential, stubPasskey } from "./admin-webauthn"
import {
  fakeGate,
  json,
  sealedHealth,
  simplefinPrepared,
} from "./fixtures/admin-connectors"
import { describeStates } from "./render-states"

const SECRET = "setup-token-4f9c2d"

const sign: Signer = (_change, send) => send()

const field = () => (
  <AdminSecretField
    label="Setup token"
    submitLabel="Seal and connect"
    busyLabel="Sealing…"
    onSeal={(read) => sealSimpleFin(sign, read)}
  />
)

/** The gate answers the signed post with `submit`; the passkey signs. */
function stubGate(submit: () => Response) {
  const gate = fakeGate({
    "POST /admin/secrets/simplefin/prepare": () => json(200, simplefinPrepared),
    "POST /admin/secrets/simplefin": submit,
  })
  vi.stubGlobal("fetch", gate.fetch)
  stubPasskey(() => Promise.resolve(new FakeCredential()))
  return gate
}

const input = (container: HTMLElement) => {
  const found = container.querySelector<HTMLInputElement>("input")
  if (found === null) throw new Error("no input")
  return found
}

/** Types the secret and submits the form, then waits for the post to settle. */
async function typeAndSubmit(container: HTMLElement, value: string) {
  input(container).value = value
  const form = container.querySelector("form")
  form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (container.querySelector("button[disabled]") === null) return
  }
}

describeStates("Admin secret field", [
  {
    state: "idle",
    render: field,
    role: "status",
    message: "",
  },
  {
    state: "sealed",
    render: () => {
      stubGate(() => json(201, sealedHealth))
      return field()
    },
    interact: (container) => typeAndSubmit(container, SECRET),
    role: "status",
    message: "Sealed in the gate's vault. The field is cleared.",
  },
  {
    state: "passkey signature refused",
    render: () => {
      stubGate(() =>
        json(403, { code: "verification_failed", message: "refused" })
      )
      return field()
    },
    interact: (container) => typeAndSubmit(container, SECRET),
    role: "alert",
    message:
      "Not saved: the passkey signature was refused. The field is cleared; type it again.",
  },
  {
    state: "gate refused the value",
    render: () => {
      stubGate(() =>
        json(400, { code: "invalid_request", message: "bad token" })
      )
      return field()
    },
    interact: (container) => typeAndSubmit(container, SECRET),
    role: "alert",
    message:
      "Not saved: the gate did not accept that value. The field is cleared; type it again.",
  },
  {
    state: "nothing typed",
    render: field,
    interact: (container) => typeAndSubmit(container, ""),
    role: "alert",
    message: "Enter the setup token.",
  },
])

describe("the secret stays in the field", () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    vi.unstubAllGlobals()
  })

  function mount() {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    cleanup = () => {
      act(() => root.unmount())
      container.remove()
    }
    act(() => {
      root.render(field())
    })
    return container
  }

  test("the typed value is in the password field and nowhere in the markup", () => {
    stubGate(() => json(201, sealedHealth))
    const container = mount()
    input(container).value = SECRET
    expect(input(container).type).toBe("password")
    expect(input(container).value).toBe(SECRET)
    expect(container.innerHTML).not.toContain(SECRET)
  })

  test("after a sealed post the field is empty, and the request body is the only place the value went", async () => {
    const gate = stubGate(() => json(201, sealedHealth))
    const container = mount()
    await act(async () => typeAndSubmit(container, SECRET))
    expect(input(container).value).toBe("")
    expect(container.innerHTML).not.toContain(SECRET)
    expect(document.body.innerHTML).not.toContain(SECRET)
    const carrying = gate.calls.filter((call) =>
      JSON.stringify(call.body).includes(SECRET)
    )
    expect(carrying.map((call) => call.path)).toEqual([
      "/admin/secrets/simplefin",
    ])
    expect(carrying[0]?.body).toMatchObject({ setupToken: SECRET })
  })

  test("after a refused signature the field is empty and the value is not in the page", async () => {
    stubGate(() =>
      json(403, { code: "verification_failed", message: "refused" })
    )
    const container = mount()
    await act(async () => typeAndSubmit(container, SECRET))
    expect(input(container).value).toBe("")
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  test("a closed passkey prompt posts nothing and keeps what was typed", async () => {
    const gate = fakeGate({
      "POST /admin/secrets/simplefin/prepare": () =>
        json(200, simplefinPrepared),
    })
    vi.stubGlobal("fetch", gate.fetch)
    stubPasskey(() => Promise.resolve(null))
    const container = mount()
    await act(async () => typeAndSubmit(container, SECRET))
    expect(gate.calls.map((call) => call.path)).toEqual([
      "/admin/secrets/simplefin/prepare",
    ])
    expect(input(container).value).toBe(SECRET)
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Cancelled. Nothing was saved."
    )
  })

  test("the field has no reveal control and never leaves password type", () => {
    stubGate(() => json(201, sealedHealth))
    const container = mount()
    expect(
      [...container.querySelectorAll("button")].map((b) => b.textContent)
    ).toEqual(["Seal and connect"])
    expect(container.querySelectorAll("input")).toHaveLength(1)
  })
})
