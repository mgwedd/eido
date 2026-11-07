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
  args: {
    body: "Hello there",
    subject: "Re: quote",
    to: ["x@example.invalid"],
  },
  kind: "email.reply",
})
const HASH = createHash("sha256").update(PAYLOAD).digest("hex")
const intent = {
  id: "intent-a",
  kind: "email.reply",
  tier: "approval",
  state: "pending",
  origin: "reactive",
  createdAt: "2026-10-17T10:00:00.000Z",
}
const EDITED_PAYLOAD = JSON.stringify({
  args: { body: "Hello there", subject: "Re: new", to: ["x@example.invalid"] },
  kind: "email.reply",
})
const editedPrepared = {
  intentId: "intent-b",
  kind: "email.reply",
  origin: "reactive",
  state: "pending",
  payload: EDITED_PAYLOAD,
  payloadHash: createHash("sha256").update(EDITED_PAYLOAD).digest("hex"),
  nonce: "m".repeat(43),
  documentIds: [],
}

type Edit = { status: number; body: unknown }
const requests: { url: string; body: unknown }[] = []
const roots: Root[] = []

function stubGate(edit: Edit) {
  requests.length = 0
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      requests.push({
        url: `${init?.method ?? "GET"} ${url}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      })
      if (url.endsWith("/approvals"))
        return Promise.resolve(
          Response.json({
            intents: requests.some((r) => r.url.endsWith("/edit"))
              ? [{ ...intent, id: "intent-b" }]
              : [intent],
          })
        )
      if (url.endsWith("/nonce"))
        return Promise.resolve(
          Response.json({
            intentId: url.split("/").at(-2),
            kind: "email.reply",
            origin: "reactive",
            state: "pending",
            payload: url.includes("intent-b") ? EDITED_PAYLOAD : PAYLOAD,
            payloadHash: url.includes("intent-b")
              ? editedPrepared.payloadHash
              : HASH,
            nonce: "n".repeat(43),
            documentIds: [],
          })
        )
      if (url.endsWith("/history"))
        return Promise.resolve(Response.json({ intentId: "x", entries: [] }))
      if (url.endsWith("/edit"))
        return Promise.resolve(
          Response.json(edit.body, { status: edit.status })
        )
      return Promise.resolve(new Response(null, { status: 500 }))
    })
  )
}

async function settle() {
  for (let step = 0; step < 10; step += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
}

async function render(edit: Edit) {
  stubGate(edit)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<QueueView />)
  })
  await settle()
}

async function press(key: string, target: HTMLElement = document.body) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    )
  })
  await settle()
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith(label)
  )
const dialog = () => document.querySelector('[role="dialog"]')

async function type(label: string, value: string) {
  const field = [...document.querySelectorAll("label")].find((l) =>
    l.textContent?.startsWith(label)
  )
  const input = document.getElementById(
    field?.getAttribute("for") ?? "missing"
  ) as HTMLInputElement | HTMLTextAreaElement
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

async function submit() {
  act(() => {
    button("Sign and approve")?.click()
  })
  await settle()
}

const OK: Edit = { status: 200, body: editedPrepared }

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  vi.unstubAllGlobals()
  signApproval.mockReset()
  document.body.innerHTML = ""
})

describe("Edit and approve", () => {
  test("the button shows the e key and opens the editor with the card's values", async () => {
    await render(OK)
    expect(button("Edit and approve")?.querySelector("kbd")?.textContent).toBe(
      "e"
    )
    act(() => {
      button("Edit and approve")?.click()
    })
    await settle()
    expect(dialog()?.textContent).toContain("Edit and approve")
    const to = [...document.querySelectorAll("label")].find((l) =>
      l.textContent?.startsWith("To")
    )
    expect(
      (
        document.getElementById(
          to?.getAttribute("for") ?? ""
        ) as HTMLInputElement
      ).value
    ).toBe("x@example.invalid")
  })

  test("e opens the editor", async () => {
    await render(OK)
    await press("e")
    expect(dialog()).not.toBeNull()
  })

  test("e typed in a field does nothing", async () => {
    await render(OK)
    const field = document.createElement("input")
    document.body.append(field)
    await press("e", field)
    expect(dialog()).toBeNull()
  })

  test("e does nothing while the editor is open", async () => {
    await render(OK)
    await press("e")
    await press("r")
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(dialog()?.textContent).not.toContain("Why? You can skip this.")
  })

  test("Sign and approve stays off until a value changes", async () => {
    await render(OK)
    await press("e")
    expect(button("Sign and approve")?.hasAttribute("disabled")).toBe(true)
    await type("Subject", "Re: new")
    expect(button("Sign and approve")?.hasAttribute("disabled")).toBe(false)
  })

  test("sends the whole edited intent to the gate, then signs the intent it returns", async () => {
    signApproval.mockResolvedValue({
      ok: true,
      value: { intentId: "intent-b", state: "approved" },
    })
    await render(OK)
    await press("e")
    await type("Subject", "Re: new")
    await submit()
    const edit = requests.find((r) => r.url.endsWith("/edit"))
    expect(edit?.url).toBe("POST /api/gate/approvals/intent-a/edit")
    expect(edit?.body).toEqual({
      intent: {
        kind: "email.reply",
        args: {
          body: "Hello there",
          subject: "Re: new",
          to: ["x@example.invalid"],
        },
      },
    })
    expect(signApproval).toHaveBeenCalledTimes(1)
    expect(signApproval.mock.calls[0]?.[0]).toMatchObject({
      intentId: "intent-b",
      payloadHash: editedPrepared.payloadHash,
    })
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Approved"
    )
    expect(document.activeElement?.textContent).toContain("Queue clear")
  })

  test("a tier change is refused with the design's message and nothing is signed", async () => {
    await render({
      status: 409,
      body: { code: "tier_changed", message: "the edit would change the tier" },
    })
    await press("e")
    await type("To", "someone@other.invalid")
    await submit()
    expect(signApproval).not.toHaveBeenCalled()
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Edit refused. This change moves the intent to a different tier. Reject it and ask again instead."
    )
  })

  test("a policy refusal says so", async () => {
    await render({
      status: 403,
      body: { code: "forbidden", message: "policy forbids the edited intent" },
    })
    await press("e")
    await type("Subject", "Re: new")
    await submit()
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Edit refused. Policy forbids the edited intent."
    )
  })

  test("an edit the schemas refuse says the values are not valid", async () => {
    await render({
      status: 422,
      body: {
        code: "invalid_request",
        message: "the edited intent is not valid",
      },
    })
    await press("e")
    await type("Subject", "Re: new")
    await submit()
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Edit refused. The edited values are not a valid intent."
    )
  })

  test("a cancelled passkey prompt moves to the saved edit instead of the stale card", async () => {
    signApproval.mockResolvedValue({
      ok: false,
      error: { code: "cancelled", message: "x" },
    })
    await render(OK)
    await press("e")
    await type("Subject", "Re: new")
    await submit()
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Edit saved. The passkey prompt did not complete, so the edited intent is waiting in the queue."
    )
    expect(document.querySelector("h2")?.id).toBe("card-intent-b")
    expect(document.activeElement?.id).toBe("card-intent-b")
  })

  test("an intent decided elsewhere meanwhile closes the editor and leaves the card", async () => {
    await render({
      status: 409,
      body: {
        code: "already_decided",
        message: "the intent is no longer pending",
      },
    })
    await press("e")
    await type("Subject", "Re: new")
    await submit()
    expect(signApproval).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Already decided"
    )
  })

  test("a passkey failure that is not a cancel shows the gate's reason on the saved edit", async () => {
    signApproval.mockResolvedValue({
      ok: false,
      error: { code: "network", message: "The gate could not be reached." },
    })
    await render(OK)
    await press("e")
    await type("Subject", "Re: new")
    await submit()
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "The gate could not be reached."
    )
    expect(document.activeElement?.id).toBe("card-intent-b")
  })

  test("after a successful edit-and-approve with remaining cards, focus moves to the next card heading", async () => {
    signApproval.mockResolvedValue({
      ok: true,
      value: { intentId: "intent-b", state: "approved" },
    })
    const secondIntent = {
      ...intent,
      id: "intent-c",
      kind: "calendar.event",
    }
    requests.length = 0
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        requests.push({
          url: `${init?.method ?? "GET"} ${url}`,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        })
        if (url.endsWith("/approvals"))
          return Promise.resolve(
            Response.json({
              intents: [intent, secondIntent],
            })
          )
        if (url.endsWith("/nonce"))
          return Promise.resolve(
            Response.json({
              intentId: url.split("/").at(-2),
              kind: url.includes("intent-c") ? "calendar.event" : "email.reply",
              origin: "reactive",
              state: "pending",
              payload: PAYLOAD,
              payloadHash: HASH,
              nonce: "n".repeat(43),
              documentIds: [],
            })
          )
        if (url.endsWith("/history"))
          return Promise.resolve(Response.json({ intentId: "x", entries: [] }))
        if (url.endsWith("/edit"))
          return Promise.resolve(Response.json(OK.body, { status: OK.status }))
        return Promise.resolve(new Response(null, { status: 500 }))
      })
    )
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => {
      root.render(<QueueView />)
    })
    await settle()

    await press("e")
    await type("Subject", "Re: new")
    await submit()

    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Approved"
    )
    expect(document.activeElement?.id).toBe("card-intent-c")
  })
})
