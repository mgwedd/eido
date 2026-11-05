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
const UNLOCK = "/unlock?next=%2Fqueue%3Fa%3D1&expired=1"

type Statuses = {
  list?: number
  nonce?: number
  history?: number
  decision?: number
}

const roots: Root[] = []
const replace = vi.fn()

function stubGate(statuses: Statuses = {}) {
  const refused = (status: number) =>
    status === 401
      ? Response.json(
          { code: "unauthenticated", message: "sign in with your passkey" },
          { status }
        )
      : new Response(null, { status })
  vi.stubGlobal("location", {
    pathname: "/queue",
    search: "?a=1",
    replace,
  })
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("/passkey/status"))
        return Promise.resolve(
          Response.json({
            enrolled: true,
            revoked: false,
            sessionExpiresAt: null,
          })
        )
      if (url.endsWith("/approvals"))
        return Promise.resolve(
          statuses.list ? refused(statuses.list) : Response.json({ intents })
        )
      if (url.endsWith("/nonce"))
        return Promise.resolve(
          statuses.nonce
            ? refused(statuses.nonce)
            : Response.json({
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
        return Promise.resolve(
          statuses.history
            ? refused(statuses.history)
            : Response.json({ intentId: "intent-a", entries: [] })
        )
      if (url.endsWith("/decision"))
        return Promise.resolve(refused(statuses.decision ?? 503))
      return Promise.resolve(new Response("nope", { status: 503 }))
    })
  )
}

async function render(statuses: Statuses) {
  stubGate(statuses)
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
  return container
}

const button = (prefix: string) =>
  [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith(prefix)
  )

async function press(prefix: string) {
  act(() => {
    button(prefix)?.click()
  })
  for (let step = 0; step < 5; step += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  vi.unstubAllGlobals()
  replace.mockReset()
  document.body.innerHTML = ""
})

describe("Queue with an ended session", () => {
  test("a 401 on the queue list goes to /unlock and keeps the page to return to", async () => {
    await render({ list: 401 })
    expect(replace).toHaveBeenCalledWith(UNLOCK)
  })

  test("a 401 preparing a card goes to /unlock", async () => {
    await render({ nonce: 401 })
    expect(replace).toHaveBeenCalledWith(UNLOCK)
  })

  test("a 401 loading a card's history goes to /unlock", async () => {
    await render({ history: 401 })
    expect(replace).toHaveBeenCalledWith(UNLOCK)
  })

  test("a 401 on reject goes to /unlock", async () => {
    await render({ decision: 401 })
    await press("Reject")
    await press("Skip")
    expect(replace).toHaveBeenCalledWith(UNLOCK)
  })

  test("a 503 on the queue list stays on the page with the unreachable state", async () => {
    await render({ list: 503 })
    expect(replace).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("Retry")
  })
})
