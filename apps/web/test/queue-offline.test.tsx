// @vitest-environment happy-dom
import { createHash } from "node:crypto"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { QueueView } from "../components/queue-view"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
  }) => <a href={href}>{children}</a>,
}))

const reachability = vi.hoisted(() => {
  const state: { value: "reachable" | "unreachable" } = { value: "reachable" }
  return state
})
vi.mock("../components/reachability", () => ({
  useReachability: () => reachability.value,
}))

const signApproval = vi.hoisted(() => vi.fn())
vi.mock(
  "../lib/approval/sign",
  async (importOriginal: () => Promise<object>) => ({
    ...(await importOriginal()),
    signApproval,
  })
)

const PAYLOAD = JSON.stringify({
  args: { body: "Hello", subject: "Re: quote", to: ["x@example.invalid"] },
  kind: "email.reply",
})
const HASH = createHash("sha256").update(PAYLOAD).digest("hex")
const intents = [
  {
    id: "intent-a",
    kind: "email.reply",
    tier: "approval",
    state: "pending",
    origin: "reactive",
    createdAt: "2026-10-17T10:00:00.000Z",
  },
]

const roots: Root[] = []

function stubGate() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("/passkey/status"))
        return Promise.resolve(
          Response.json({ enrolled: true, sessionExpiresAt: null })
        )
      if (url.endsWith("/approvals"))
        return Promise.resolve(Response.json({ intents }))
      if (url.endsWith("/nonce"))
        return Promise.resolve(
          Response.json({
            intentId: "intent-a",
            kind: "email.reply",
            origin: "reactive",
            state: "pending",
            payload: PAYLOAD,
            payloadHash: HASH,
            nonce: "n".repeat(43),
            documentIds: [],
            rationale: "Note.",
          })
        )
      if (url.endsWith("/history"))
        return Promise.resolve(Response.json({ intentId: "x", entries: [] }))
      return Promise.resolve(new Response("nope", { status: 503 }))
    })
  )
}

async function render() {
  stubGate()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<QueueView />)
  })
  for (let step = 0; step < 10; step += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
}

const button = (prefix: string) =>
  [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith(prefix)
  )

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  vi.unstubAllGlobals()
  signApproval.mockReset()
  reachability.value = "reachable"
  document.body.innerHTML = ""
})

describe("Queue offline", () => {
  test("disables Approve, Edit and Reject and says why", async () => {
    reachability.value = "unreachable"
    await render()
    expect(button("Approve")?.disabled).toBe(true)
    expect(button("Edit and approve")?.disabled).toBe(true)
    expect(button("Reject")?.disabled).toBe(true)
    expect(document.body.textContent).toContain(
      "Offline. Approvals need a connection."
    )
    expect(document.body.textContent).toMatch(
      /Cards below were loaded at \d\d:\d\d and cannot be signed until the Mac is reachable\./
    )
  })

  test("the a key does not sign while offline", async () => {
    reachability.value = "unreachable"
    await render()
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true })
      )
    })
    expect(signApproval).not.toHaveBeenCalled()
  })

  test("Approve is enabled when reachable", async () => {
    await render()
    expect(button("Approve")?.disabled).toBe(false)
    expect(document.body.textContent).not.toContain("Offline.")
  })
})
