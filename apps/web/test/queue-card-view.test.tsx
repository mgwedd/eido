// @vitest-environment happy-dom
import { createHash } from "node:crypto"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { QueueView } from "../components/queue-view"
import { queued } from "./fixtures/queue"

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

const signApproval = vi.hoisted(() => vi.fn())
vi.mock(
  "../lib/approval/sign",
  async (importOriginal: () => Promise<object>) => ({
    ...(await importOriginal()),
    signApproval,
  })
)

const PAYLOAD = JSON.stringify({
  args: {
    body: "Hello there",
    subject: "Re: quote",
    to: ["x@example.invalid"],
  },
  kind: "email.reply",
})
const HASH = createHash("sha256").update(PAYLOAD).digest("hex")
const NONCE = "n".repeat(43)

function prepared(hash: string) {
  return {
    intentId: "intent-a",
    kind: "email.reply",
    origin: "reactive",
    state: "pending",
    payload: PAYLOAD,
    payloadHash: hash,
    nonce: NONCE,
    documentIds: ["d1", "d2"],
    rationale: "The thread waited three days.",
  }
}

type Routes = {
  hash?: string
  history?: "ok" | "fail" | "empty"
  decision?: number
}

function routed(routes: Routes = {}) {
  const calls: { url: string; body?: string }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      if (url.endsWith("/approvals"))
        return Promise.resolve(Response.json({ intents: queued }))
      if (url.endsWith("/nonce"))
        return Promise.resolve(Response.json(prepared(routes.hash ?? HASH)))
      if (url.endsWith("/history"))
        return Promise.resolve(
          routes.history === "fail"
            ? new Response(null, { status: 500 })
            : Response.json({
                intentId: "intent-a",
                entries:
                  routes.history === "empty"
                    ? []
                    : [
                        {
                          at: "2026-10-17T10:00:00.000Z",
                          from: null,
                          to: "proposed",
                          actor: "data-plane",
                        },
                        {
                          at: "2026-10-17T10:01:00.000Z",
                          from: "proposed",
                          to: "pending",
                          actor: "policy",
                        },
                      ],
              })
        )
      return Promise.resolve(
        routes.decision === 409
          ? new Response(null, { status: 409 })
          : Response.json({ intentId: "intent-a", state: "rejected" })
      )
    })
  )
  return calls
}

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(<QueueView />)
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return container
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === label)

async function click(label: string) {
  await act(async () => {
    button(label)?.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  signApproval.mockReset()
  document.body.innerHTML = ""
})

describe("Queue card", () => {
  test("shows the payload fields, the agent note apart and the short hash", async () => {
    routed()
    const view = await render()
    expect(view.querySelector("article h2")?.textContent).toBe(
      "Reply to x@example.invalid"
    )
    expect([...view.querySelectorAll("dt")].map((n) => n.textContent)).toEqual([
      "To",
      "Subject",
      "Message",
    ])
    expect(view.textContent).toContain("Context used · 2 linked sources")
    expect(view.textContent).toContain("The thread waited three days.")
    expect(view.textContent).toContain(
      `Payload hash · ${HASH.slice(0, 4)} ${HASH.slice(4, 8)}`
    )
    expect(view.querySelector("time")?.getAttribute("title")).toBe(
      "2026-10-17T10:00:00.000Z"
    )
  })

  test("a payload that does not match its hash shows the mismatch alert and no Approve", async () => {
    routed({ hash: "0".repeat(64) })
    const view = await render()
    expect(view.querySelector('[role="alert"]')?.textContent).toBe(
      "Payload changed. Reload the card."
    )
    expect(button("Approve")?.disabled).toBe(true)
  })

  test("history failure shows an alert and Retry reloads it", async () => {
    routed({ history: "fail" })
    const view = await render()
    expect(view.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not load history from the audit log."
    )
    routed({ history: "ok" })
    await click("Retry")
    expect(view.textContent).toContain("proposed")
  })

  test("empty history says so", async () => {
    routed({ history: "empty" })
    const view = await render()
    expect(view.textContent).toContain("No history recorded")
  })

  test("reject with a reason sends the reason code and clears the queue", async () => {
    const calls = routed()
    const view = await render()
    await click("Reject")
    await click("Wrong tone")
    const decision = calls.find((c) => c.url.endsWith("/decision"))
    expect(JSON.parse(decision?.body ?? "{}")).toEqual({
      intentId: "intent-a",
      decision: "rejected",
      reasonCode: "wrong_tone",
    })
    expect(view.textContent).toContain("Rejected · reason saved for evals")
    expect(view.textContent).toContain("Queue clear")
  })

  test("reject with Skip sends no reason", async () => {
    const calls = routed()
    const view = await render()
    await click("Reject")
    await click("Skip")
    const decision = calls.find((c) => c.url.endsWith("/decision"))
    expect(JSON.parse(decision?.body ?? "{}")).toEqual({
      intentId: "intent-a",
      decision: "rejected",
    })
    expect(view.textContent).not.toContain("reason saved")
  })

  test("a 409 on reject removes the card as already decided", async () => {
    routed({ decision: 409 })
    const view = await render()
    await click("Reject")
    await click("Skip")
    expect(view.textContent).toContain("Already decided")
  })

  test("approve signs over the prepared approval and then says Approved", async () => {
    routed()
    signApproval.mockResolvedValue({
      ok: true,
      value: { intentId: "intent-a", state: "approved" },
    })
    const view = await render()
    await click("Approve")
    expect(signApproval).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: NONCE, payloadHash: HASH })
    )
    expect(view.textContent).toContain("Approved")
  })

  test("a cancelled Face ID shows its own message and keeps the card", async () => {
    routed()
    signApproval.mockResolvedValue({
      ok: false,
      error: { code: "cancelled", message: "x" },
    })
    const view = await render()
    await click("Approve")
    expect(view.textContent).toContain(
      "Face ID did not complete. Nothing was approved."
    )
    expect(button("Approve")?.disabled).toBe(false)
  })

  test("a refused signature explains what happened", async () => {
    routed()
    signApproval.mockResolvedValue({
      ok: false,
      error: { code: "verification_failed", message: "x" },
    })
    const view = await render()
    await click("Approve")
    expect(view.textContent).toContain(
      "What you saw and what is stored differ. The intent was rejected and an alert was logged."
    )
  })
})

async function drag(article: Element, from: number, to: number) {
  Object.assign(article, { setPointerCapture: () => undefined })
  for (const [type, x] of [
    ["pointerdown", from],
    ["pointermove", to],
    ["pointerup", to],
  ] as const) {
    await act(async () => {
      const event = new Event(type, { bubbles: true })
      Object.assign(event, { clientX: x, pointerId: 1 })
      article.dispatchEvent(event)
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
}

describe("Queue swipe", () => {
  test("a swipe right past the threshold approves", async () => {
    routed()
    signApproval.mockResolvedValue({
      ok: true,
      value: { intentId: "intent-a", state: "approved" },
    })
    const view = await render()
    await drag(view.querySelector("article")!, 0, 120)
    expect(signApproval).toHaveBeenCalledTimes(1)
  })

  test("a short swipe does nothing", async () => {
    routed()
    const view = await render()
    await drag(view.querySelector("article")!, 0, 60)
    expect(signApproval).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain("Why? You can skip this.")
  })

  test("a swipe left past the threshold opens the reject sheet", async () => {
    routed()
    const view = await render()
    await drag(view.querySelector("article")!, 200, 50)
    expect(document.body.textContent).toContain("Why? You can skip this.")
  })
})
