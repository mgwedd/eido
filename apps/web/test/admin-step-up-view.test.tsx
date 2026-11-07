// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- fetch and passkey stubs return promises */
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  AdminProvider,
  useAdmin,
  type AdminResult,
} from "../components/admin-step-up"
import type { GateOutcome } from "@/lib/admin/gate"
import type { SubmitOutcome } from "@/lib/admin/control"
import { FakeCredential, stubPasskey } from "./admin-webauthn"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const push = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/admin/model",
}))

// Five minutes ahead, as the gate grants; a far date would overflow the expiry timer.
const FUTURE = new Date(Date.now() + 300_000).toISOString()
const options = {
  challenge: "C".repeat(43),
  rpId: "eido.example.invalid",
  expiresAt: FUTURE,
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

/** The gate for the step-up routes: `until` is what GET /auth/step-up answers. */
function stubGate(until: string | null, stepUpStatus = 200) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/gate/auth/step-up/options") return json(200, options)
    if (url === "/api/gate/auth/step-up" && init?.method === "POST")
      return stepUpStatus === 200
        ? json(200, { expiresAt: FUTURE })
        : json(stepUpStatus, { code: "assertion_invalid", message: "No." })
    if (url === "/api/gate/auth/step-up") return json(200, { expiresAt: until })
    return json(404, {})
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

let container: HTMLElement
let root: Root
const probe: { value: ReturnType<typeof useAdmin> | null } = { value: null }

/** The provider's value, as the Probe last rendered it. */
function admin(): ReturnType<typeof useAdmin> {
  if (probe.value === null) throw new Error("Probe has not rendered")
  return probe.value
}

function Probe() {
  const value = useAdmin()
  React.useEffect(() => {
    probe.value = value
  })
  return <p data-testid="until">{value.elevatedUntil ?? "none"}</p>
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(onElevated?: () => void) {
  await act(async () => {
    root.render(
      <AdminProvider onElevated={onElevated}>
        <Probe />
      </AdminProvider>
    )
  })
  await settle()
}

function button(name: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name
  )
  if (found === undefined) throw new Error(`no button ${name}`)
  return found
}

async function click(name: string) {
  await act(async () => {
    button(name).click()
  })
  await settle()
  await settle()
}

const promptText = () => document.body.querySelector("form")?.textContent ?? ""

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  push.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

describe("AdminProvider elevated", () => {
  it("runs at once while the session is stepped up", async () => {
    stubGate(FUTURE)
    await mount()
    const run = vi.fn(async (): Promise<GateOutcome<number>> => ({
      kind: "ok",
      status: 200,
      value: 1,
    }))
    let result: AdminResult<number> | undefined
    await act(async () => {
      result = await admin().elevated("Use qwen", run)
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ kind: "ok", status: 200, value: 1 })
    expect(document.body.querySelector("form")).toBeNull()
  })

  it("asks for a step-up first, then runs and reports it", async () => {
    stubGate(null)
    stubPasskey(async () => new FakeCredential())
    const onElevated = vi.fn()
    await mount(onElevated)
    const run = vi.fn(async (): Promise<GateOutcome<number>> => ({
      kind: "ok",
      status: 200,
      value: 2,
    }))
    let pending: Promise<AdminResult<number>> | undefined
    await act(async () => {
      pending = admin().elevated("Restart core and llama", run)
    })
    expect(promptText()).toContain("Confirm it's you")
    expect(run).not.toHaveBeenCalled()
    await click("Confirm with passkey")
    expect(await pending).toEqual({ kind: "ok", status: 200, value: 2 })
    expect(onElevated).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe(FUTURE)
  })

  it("changes nothing when the owner cancels", async () => {
    stubGate(null)
    await mount()
    const run = vi.fn()
    let pending: Promise<AdminResult<never>> | undefined
    await act(async () => {
      pending = admin().elevated("Stop core and llama", run)
    })
    await click("Cancel")
    expect(await pending).toEqual({ kind: "cancelled" })
    expect(run).not.toHaveBeenCalled()
  })

  it("shows Not confirmed when the gate refuses the passkey, and Try again works", async () => {
    stubGate(null, 400)
    stubPasskey(async () => new FakeCredential())
    await mount()
    const run = vi.fn(async (): Promise<GateOutcome<number>> => ({
      kind: "ok",
      status: 200,
      value: 3,
    }))
    let pending: Promise<AdminResult<number>> | undefined
    await act(async () => {
      pending = admin().elevated("Use qwen", run)
    })
    await click("Confirm with passkey")
    expect(promptText()).toContain("Not confirmed")
    stubGate(null)
    await click("Try again")
    expect(await pending).toEqual({ kind: "ok", status: 200, value: 3 })
  })

  it("asks again when the gate says the step-up ended, then reruns", async () => {
    stubGate(FUTURE)
    stubPasskey(async () => new FakeCredential())
    await mount()
    const run = vi
      .fn<() => Promise<GateOutcome<number>>>()
      .mockResolvedValueOnce({ kind: "step-up" })
      .mockResolvedValueOnce({ kind: "ok", status: 200, value: 4 })
    let pending: Promise<AdminResult<number>> | undefined
    await act(async () => {
      pending = admin().elevated("Restart core and llama", run)
    })
    await settle()
    expect(promptText()).toContain(
      "Your 5 minutes ended. Nothing changed. Confirm again to restart core and llama."
    )
    await click("Confirm with passkey")
    expect(await pending).toEqual({ kind: "ok", status: 200, value: 4 })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("sends the owner to sign in when the session ended", async () => {
    stubGate(FUTURE)
    await mount()
    await act(async () => {
      await admin().elevated("Use qwen", async () => ({ kind: "expired" }))
    })
    expect(push).toHaveBeenCalledWith("/unlock?next=%2Fadmin%2Fmodel&expired=1")
  })
})

describe("AdminProvider signed", () => {
  const change = {
    action: "Issue enrolment code",
    fields: [["Action", "enrolment_code.issue"]] as const,
    payloadHash: "abcd1234".repeat(8),
  }

  it("shows the change and its hash, then sends on Sign", async () => {
    stubGate(null)
    await mount()
    const send = vi.fn(async (): Promise<SubmitOutcome<string>> => ({
      kind: "ok",
      status: 200,
      value: "done",
    }))
    let pending: Promise<SubmitOutcome<string>> | undefined
    await act(async () => {
      pending = admin().signed(change, send)
    })
    expect(promptText()).toContain("Sign this change")
    expect(promptText()).toContain("enrolment_code.issue")
    expect(promptText()).toContain("abcd 1234")
    expect(send).not.toHaveBeenCalled()
    await click("Sign with passkey")
    expect(await pending).toEqual({ kind: "ok", status: 200, value: "done" })
    expect(document.body.querySelector("form")).toBeNull()
  })

  it("resolves cancelled without sending when the owner cancels", async () => {
    stubGate(null)
    await mount()
    const send = vi.fn()
    let pending: Promise<SubmitOutcome<never>> | undefined
    await act(async () => {
      pending = admin().signed(change, send)
    })
    await click("Cancel")
    expect(await pending).toEqual({ kind: "cancelled" })
    expect(send).not.toHaveBeenCalled()
  })

  it("sends the owner to sign in when the gate answers 401", async () => {
    stubGate(null)
    await mount()
    let pending: Promise<SubmitOutcome<never>> | undefined
    await act(async () => {
      pending = admin().signed(change, async () => ({ kind: "expired" }))
    })
    await click("Sign with passkey")
    expect(await pending).toEqual({ kind: "expired" })
    expect(push).toHaveBeenCalledWith("/unlock?next=%2Fadmin%2Fmodel&expired=1")
  })
})

describe("useAdmin", () => {
  it("needs a provider", () => {
    function Bare() {
      useAdmin()
      return null
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => act(() => root.render(<Bare />))).toThrow(
      "useAdmin needs an AdminProvider"
    )
    spy.mockRestore()
  })
})
