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
const intents = ["intent-a", "intent-b", "intent-c"].map((id) => ({
  id,
  kind: "email.reply",
  tier: "approval",
  state: "pending",
  origin: "reactive",
  createdAt: "2026-10-17T10:00:00.000Z",
}))

const calls: string[] = []
const roots: Root[] = []

function mount(): void {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<QueueView />)
  })
}

function stubGate() {
  calls.length = 0
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`)
      if (url.endsWith("/approvals"))
        return Promise.resolve(Response.json({ intents }))
      if (url.endsWith("/nonce"))
        return Promise.resolve(
          Response.json({
            intentId: url.split("/").at(-2),
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
      return Promise.resolve(
        Response.json({ intentId: "intent-a", state: "rejected" })
      )
    })
  )
}

async function settle() {
  for (let step = 0; step < 10; step += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
}

async function render() {
  stubGate()
  mount()
  await settle()
}

async function press(
  key: string,
  target: HTMLElement = document.body,
  init: KeyboardEventInit = {}
) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      })
    )
  })
  await settle()
}

const position = () =>
  document.querySelector("header p")?.textContent ?? "no position"
const selectedRow = () =>
  document
    .querySelector('[data-queue-row][aria-current="true"]')
    ?.getAttribute("data-queue-row")

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  vi.unstubAllGlobals()
  signApproval.mockReset()
  document.body.innerHTML = ""
})

describe("Queue shortcuts", () => {
  test("j moves to the next intent and k back, stopping at both ends", async () => {
    await render()
    expect(position()).toBe("1 of 3")
    await press("k")
    expect(position()).toBe("1 of 3")
    await press("j")
    expect(position()).toBe("2 of 3")
    expect(selectedRow()).toBe("intent-b")
    await press("j")
    await press("j")
    expect(position()).toBe("3 of 3")
    await press("k")
    expect(position()).toBe("2 of 3")
  })

  test("a starts the passkey signing for the shown intent and nothing else signs", async () => {
    await render()
    signApproval.mockResolvedValue({
      ok: false,
      error: { code: "cancelled", message: "x" },
    })
    await press("a")
    expect(signApproval).toHaveBeenCalledTimes(1)
    expect(signApproval.mock.calls[0]?.[0]).toMatchObject({
      intentId: "intent-a",
      payloadHash: HASH,
    })
    expect(
      document.querySelector('[role="alert"], [data-slot="alert"]')?.textContent
    ).toContain("The passkey prompt did not complete. Nothing was approved.")
  })

  test("a does not sign while the payload has not loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith("/approvals")
            ? Response.json({ intents })
            : new Response(null, { status: 500 })
        )
      )
    )
    mount()
    await settle()
    await press("a")
    expect(signApproval).not.toHaveBeenCalled()
  })

  test("r opens the reject sheet and a reason posts the rejection", async () => {
    await render()
    await press("r")
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Why? You can skip this."
    )
    const skip = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Skip"
    )
    act(() => {
      skip?.click()
    })
    await settle()
    expect(calls).toContain("POST /api/gate/approvals/intent-a/decision")
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Rejected"
    )
  })

  test("with the reject sheet open, a signs nothing and j does not move", async () => {
    await render()
    await press("r")
    await press("a")
    await press("j")
    expect(signApproval).not.toHaveBeenCalled()
    expect(position()).toBe("1 of 3")
  })

  test("Enter moves focus to the card", async () => {
    await render()
    await press("Enter")
    expect(document.activeElement?.id).toBe("card-intent-a")
  })

  test("Enter on a focused button leaves the button to act", async () => {
    await render()
    const row = document.querySelector<HTMLElement>(
      '[data-queue-row="intent-b"]'
    )
    row?.focus()
    await press("Enter", row as HTMLElement)
    expect(document.activeElement?.id).not.toBe("card-intent-b")
  })

  test("Escape returns focus to the selected row in the list", async () => {
    await render()
    await press("j")
    await press("Enter")
    expect(document.activeElement?.id).toBe("card-intent-b")
    await press("Escape", document.activeElement as HTMLElement)
    expect(document.activeElement?.getAttribute("data-queue-row")).toBe(
      "intent-b"
    )
  })

  test.each(["a", "r", "j", "k", "Enter"])(
    "%s typed in an input does nothing",
    async (key) => {
      await render()
      const field = document.createElement("input")
      document.body.append(field)
      await press("j")
      const before = position()
      await press(key, field)
      expect(signApproval).not.toHaveBeenCalled()
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(position()).toBe(before)
      expect(document.activeElement?.id).not.toBe("card-intent-b")
    }
  )

  test("a held modifier, as in the browser's own shortcuts, is ignored", async () => {
    await render()
    await press("a", document.body, { metaKey: true })
    expect(signApproval).not.toHaveBeenCalled()
  })

  test("the action buttons show their keys", async () => {
    await render()
    const keysOf = (label: string) =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.startsWith(label))
        ?.querySelector("kbd")?.textContent
    expect(keysOf("Approve")).toBe("a")
    expect(keysOf("Reject")).toBe("r")
  })
})
