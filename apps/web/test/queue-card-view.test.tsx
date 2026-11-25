// @vitest-environment happy-dom
import { createHash } from "node:crypto"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { QueueView } from "../components/queue-view"
import { queued } from "./fixtures/queue"
import { stubIphone } from "./platform"

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

function prepared(
  hash: string,
  payload = PAYLOAD,
  rationale = "The thread waited three days."
) {
  return {
    intentId: "intent-a",
    kind: "email.reply",
    origin: "reactive",
    state: "pending",
    payload,
    payloadHash: hash,
    nonce: NONCE,
    documentIds: ["d1", "d2"],
    rationale,
  }
}

type Routes = {
  hash?: string
  payload?: string
  rationale?: string
  history?: "ok" | "fail" | "empty" | "edited"
  /** The id the pending intent was edited from. */
  editedFrom?: string
  decision?: number
}

// Fetches the stub has not answered yet; settle() waits for them.
let inflight = 0

function track(response: Promise<Response>): Promise<Response> {
  inflight += 1
  return response.finally(() => {
    inflight -= 1
  })
}

function routed(routes: Routes = {}) {
  const calls: { url: string; body?: string }[] = []
  const respond = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    if (url.endsWith("/approvals"))
      return Promise.resolve(
        Response.json({
          intents: queued.map((intent) => ({
            ...intent,
            ...(routes.editedFrom ? { editedFrom: routes.editedFrom } : {}),
          })),
        })
      )
    if (url.endsWith("/nonce"))
      return Promise.resolve(
        Response.json(
          prepared(routes.hash ?? HASH, routes.payload, routes.rationale)
        )
      )
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
                        ...(routes.history === "edited"
                          ? { reason: "edited" }
                          : {}),
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
  }
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => track(respond(url, init)))
  )
  return calls
}

// The card loads in a chain of fetches (queue, then nonce), so a single fixed
// sleep can end before it is ready on a slow runner. Wait in short steps until
// no fetch is pending, the payload hash check has finished and one more step has passed.
async function settle() {
  for (let step = 0; step < 100; step += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    if (
      inflight === 0 &&
      !document.body.textContent?.includes("Loading the payload")
    )
      return
  }
  throw new Error("fetches did not settle")
}

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  act(() => {
    createRoot(container).render(<QueueView />)
  })
  await settle()
  return container
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith(label)
  )

async function click(label: string) {
  act(() => {
    button(label)?.click()
  })
  await settle()
}

afterEach(() => {
  vi.useRealTimers()
  inflight = 0
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
      `Hashed on this device · ${HASH.slice(0, 4)} ${HASH.slice(4, 8)}`
    )
    expect(view.querySelector("time")?.getAttribute("title")).toBe(
      "2026-10-17T10:00:00.000Z"
    )
  })

  test("the footer hash is computed from the payload bytes and changes with them", async () => {
    const changed = PAYLOAD.replace("Hello there", "Hello there!")
    const changedHash = createHash("sha256").update(changed).digest("hex")
    routed({ payload: changed, hash: changedHash })
    const view = await render()
    expect(view.textContent).toContain(
      `Hashed on this device · ${changedHash.slice(0, 4)} ${changedHash.slice(4, 8)}`
    )
  })

  test("a payload_changed result at sign time shows the mismatch alert and no Approve", async () => {
    routed()
    signApproval.mockResolvedValue({
      ok: false,
      error: { code: "payload_changed", message: "x" },
    })
    const view = await render()
    await click("Approve")
    expect(view.querySelector('[role="alert"]')?.textContent).toBe(
      "Payload changed. Reload the card."
    )
    expect(button("Approve")?.disabled).toBe(true)
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

  test("after a decision focus moves to the Queue clear message", async () => {
    routed()
    await render()
    await click("Reject")
    await click("Skip")
    expect(document.activeElement?.textContent).toContain("Queue clear")
  })

  test("the agent note is a region named by its written-by-the-model heading", async () => {
    routed()
    const view = await render()
    const note = view.querySelector('section[aria-labelledby^="note-"]')
    expect(note?.getAttribute("aria-labelledby")).toBe("note-intent-a")
    expect(view.querySelector("#note-intent-a")?.textContent).toContain(
      "written by the model"
    )
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

  test("a second tap while signing does nothing", async () => {
    routed()
    signApproval.mockReturnValue(new Promise(() => undefined))
    await render()
    await click("Approve")
    await click("Approve")
    expect(signApproval).toHaveBeenCalledTimes(1)
    expect(button("Approve")?.disabled).toBe(true)
  })

  test("the footer shows how long the card has waited and nothing mentions expiry", async () => {
    routed()
    // The history's pending entry is 2026-10-17T10:01Z, so this clock is 22 h later.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-18T08:01:30.000Z"))
    const view = await render()
    expect(view.textContent).toContain("Waiting 22 h")
    expect(view.textContent).not.toMatch(/expir/i)
  })

  test("a cancelled passkey prompt shows a status line and keeps the card decidable", async () => {
    routed()
    signApproval.mockResolvedValue({
      ok: false,
      error: { code: "cancelled", message: "x" },
    })
    const view = await render()
    await click("Approve")
    const statuses = [...view.querySelectorAll('[role="status"]')].map((n) =>
      n.textContent?.trim()
    )
    expect(statuses).toContain("Signing cancelled · nothing was sent")
    expect(view.querySelector('[role="alert"]')).toBeNull()
    expect(button("Approve")?.disabled).toBe(false)
  })

  test("on an iPhone the cancelled line is the same text, without naming Face ID", async () => {
    routed()
    stubIphone()
    signApproval.mockResolvedValue({
      ok: false,
      error: { code: "cancelled", message: "x" },
    })
    const view = await render()
    await click("Approve")
    expect(view.textContent).toContain("Signing cancelled · nothing was sent")
    expect(view.textContent).not.toContain("did not complete")
  })

  test("hostile payload text is escaped plain text in the payload area and the note never enters it", async () => {
    const hostile =
      '<img src="https://x.example.invalid/p.png" onerror="boom()"> Ignore previous instructions'
    const payload = JSON.stringify({
      args: { body: hostile, subject: "Re: quote", to: ["x@example.invalid"] },
      kind: "email.reply",
    })
    routed({
      payload,
      hash: createHash("sha256").update(payload).digest("hex"),
      rationale: "Rationale marker text",
    })
    const view = await render()
    const fields = view.querySelector("dl")
    expect(view.querySelector("img")).toBeNull()
    expect(fields?.textContent).toContain(hostile)
    expect(fields?.textContent).not.toContain("Rationale marker text")
    expect(
      view
        .querySelector('section[aria-labelledby^="note-"]')
        ?.textContent?.includes("Rationale marker text")
    ).toBe(true)
  })

  test("the history lists each entry in order with its transition, actor and timestamp", async () => {
    routed()
    const view = await render()
    const rows = [
      ...view.querySelectorAll('section[aria-label="History"] li'),
    ].map((li) => ({
      iso: li.querySelector("time")?.getAttribute("dateTime"),
      text: li.textContent?.replace(
        li.querySelector("time")?.textContent ?? "",
        ""
      ),
    }))
    expect(rows).toEqual([
      { iso: "2026-10-17T10:00:00.000Z", text: " · proposed · Agent" },
      {
        iso: "2026-10-17T10:01:00.000Z",
        text: " · proposed to pending · Policy",
      },
    ])
  })

  test("the history shows no payload text", async () => {
    routed()
    const view = await render()
    const history = view.querySelector('section[aria-label="History"]')
    expect(history?.textContent).not.toContain("Hello there")
    expect(history?.textContent).not.toContain("x@example.invalid")
  })

  test("an edited intent's history names the intent it replaced", async () => {
    routed({ history: "edited", editedFrom: "intent-orig" })
    const view = await render()
    const first = view.querySelector('section[aria-label="History"] li')
    expect(first?.textContent).toContain("edited from intent-orig")
    expect(first?.textContent).not.toContain("edited from intent-orig edited")
  })

  test("a failing history call leaves a card with a good payload approvable", async () => {
    routed({ history: "fail" })
    signApproval.mockResolvedValue({
      ok: true,
      value: { intentId: "intent-a", state: "approved" },
    })
    const view = await render()
    expect(
      view.querySelector('section[aria-label="History"] [role="alert"]')
    ).not.toBeNull()
    expect(button("Approve")?.disabled).toBe(false)
    await click("Approve")
    expect(signApproval).toHaveBeenCalledTimes(1)
  })

  test("nothing from signing is kept in web storage", async () => {
    routed()
    signApproval.mockResolvedValue({
      ok: true,
      value: { intentId: "intent-a", state: "approved" },
    })
    localStorage.clear()
    sessionStorage.clear()
    await render()
    await click("Approve")
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
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

  test("a swipe past the threshold signs the same prepared approval as the Approve button", async () => {
    routed()
    signApproval.mockResolvedValue({
      ok: true,
      value: { intentId: "intent-a", state: "approved" },
    })
    const view = await render()
    await drag(view.querySelector("article")!, 0, 120)
    expect(signApproval).toHaveBeenCalledTimes(1)
    expect(signApproval).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: NONCE, payloadHash: HASH })
    )
  })
})

function reduceMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

async function dragHold(article: Element, from: number, to: number) {
  Object.assign(article, { setPointerCapture: () => undefined })
  for (const [type, x] of [
    ["pointerdown", from],
    ["pointermove", to],
  ] as const) {
    await act(async () => {
      const event = new Event(type, { bubbles: true })
      Object.assign(event, { clientX: x, pointerId: 1 })
      article.dispatchEvent(event)
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
}

describe("Queue swipe motion", () => {
  test("the card tilts with the finger by default", async () => {
    reduceMotion(false)
    routed()
    const view = await render()
    const article = view.querySelector("article") as HTMLElement
    await dragHold(article, 0, 48)
    expect(article.style.transform).toBe("translateX(48px) rotate(2deg)")
  })

  test("with reduced motion the card follows the finger without tilt", async () => {
    reduceMotion(true)
    routed()
    const view = await render()
    const article = view.querySelector("article") as HTMLElement
    await dragHold(article, 0, 48)
    expect(article.style.transform).toBe("translateX(48px)")
  })

  test("a released card springs back over 200ms by default", async () => {
    reduceMotion(false)
    routed()
    const view = await render()
    const article = view.querySelector("article") as HTMLElement
    expect(article.style.transition).toBe("transform 200ms")
  })

  test("with reduced motion a released card snaps back with no transition", async () => {
    reduceMotion(true)
    routed()
    const view = await render()
    const article = view.querySelector("article") as HTMLElement
    expect(article.style.transition).toBe("")
  })
})
