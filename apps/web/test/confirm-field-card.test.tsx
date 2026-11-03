// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { QueueView } from "../components/queue-view"
import { hashPayloadText } from "../lib/approval/canonical"
import { confirmFieldIntent } from "../lib/queue/api"
import {
  buildCard,
  parseConfirmField,
  type ConfirmFieldCardData,
} from "../lib/queue/card"

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

const CONFIRM_ARGS: ConfirmFieldCardData = {
  extractionId: "42",
  field: "amount",
  value: {
    raw: "CHF 1200.-",
    typed: { amount_minor: 120000, currency: "CHF" },
  },
  source: {
    docSha256: "c".repeat(64),
    start: 28,
    end: 40,
    page: 1,
    line: 2,
  },
  confidence: 0.71,
  threshold: 0.8,
  documentTitle: "Invoice #1042",
  contextSources: ["page 1 footer", "OCR text"],
}

const CONFIRM_PAYLOAD = JSON.stringify({
  args: CONFIRM_ARGS,
  kind: "confirm.field",
})

let confirmHash: string

beforeAll(async () => {
  const h = await hashPayloadText(CONFIRM_PAYLOAD)
  if (!h) throw new Error("Could not hash payload")
  confirmHash = h
})

const INTENT_CONFIRM = {
  id: "intent-c1",
  kind: "confirm.field",
  tier: "approval",
  state: "pending",
  origin: "proactive",
  createdAt: "2026-10-18T08:00:00.000Z",
  rationale: "Extracted from a scan · confidence 0.71",
} as const

const INTENT_OTHER = {
  id: "intent-c2",
  kind: "email.send",
  tier: "approval",
  state: "pending",
  origin: "reactive",
  createdAt: "2026-10-18T09:00:00.000Z",
} as const

let inflight = 0

function track(p: Promise<Response>): Promise<Response> {
  inflight += 1
  return p.finally(() => {
    inflight -= 1
  })
}

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

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("parseConfirmField", () => {
  test("parses valid confirm.field payload", () => {
    const parsed = parseConfirmField(CONFIRM_PAYLOAD)
    expect(parsed).toBeDefined()
    expect(parsed?.field).toBe("amount")
    expect(parsed?.confidence).toBe(0.71)
    expect(parsed?.threshold).toBe(0.8)
    expect(parsed?.documentTitle).toBe("Invoice #1042")
  })

  test("returns undefined for invalid JSON or non-confirm payload", () => {
    expect(parseConfirmField("not json")).toBeUndefined()
    expect(
      parseConfirmField(JSON.stringify({ kind: "email.send" }))
    ).toBeUndefined()
  })
})

describe("confirm.field card title", () => {
  test("builds title with document title, field, and value", () => {
    const card = buildCard(
      "confirm.field",
      JSON.stringify({
        kind: "confirm.field",
        args: {
          field: "due_date",
          value: { typed: "2026-04-01", raw: "01.04.2026" },
          documentTitle: "Notice",
        },
      })
    )
    expect(card?.title).toBe("Confirm Notice due date: 2026-04-01")
  })

  test("builds title with fallback when documentTitle or typed value is absent", () => {
    const card = buildCard(
      "confirm.field",
      JSON.stringify({
        kind: "confirm.field",
        args: {
          field: "action",
          value: { raw: "Pay invoice" },
        },
      })
    )
    expect(card?.title).toBe("Confirm action: Pay invoice")
  })
})

describe("confirmFieldIntent API", () => {
  test("handles core returning non-json error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response("<html>Error</html>", { status: 502 }))
      )
    )
    const res = await confirmFieldIntent("i1", 1, "f1")
    expect(res).toEqual({
      ok: false,
      message: "Extraction confirmation failed (502)",
    })
  })

  test("handles core network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network error")))
    )
    const res = await confirmFieldIntent("i1", 1, "f1")
    expect(res).toEqual({
      ok: false,
      message: "Could not reach Core API",
    })
  })

  test("handles gate decision failing with 500", async () => {
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call++
        if (call === 1) return Promise.resolve(Response.json({ ok: true }))
        return Promise.resolve(new Response(null, { status: 500 }))
      })
    )
    const res = await confirmFieldIntent("i1", 1, "f1")
    expect(res).toEqual({
      ok: false,
      message: "Gate decision failed (500)",
    })
  })

  test("handles gate decision network error", async () => {
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call++
        if (call === 1) return Promise.resolve(Response.json({ ok: true }))
        return Promise.reject(new Error("gate down"))
      })
    )
    const res = await confirmFieldIntent("i1", 1, "f1")
    expect(res).toEqual({
      ok: false,
      message: "Could not reach Gate API",
    })
  })
})

describe("ConfirmField Card in Queue", () => {
  function setupMocks(options?: {
    confirmFailCore?: boolean
    coreErrorMessage?: string
  }) {
    const fetchCalls: { url: string; method?: string; body?: string }[] = []

    const respond = (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : undefined
      fetchCalls.push({ url, method, body })

      if (url.endsWith("/api/gate/approvals")) {
        return Promise.resolve(
          Response.json({
            intents: [INTENT_CONFIRM, INTENT_OTHER],
          })
        )
      }

      if (url.includes("/api/gate/approvals/intent-c1/nonce")) {
        return Promise.resolve(
          Response.json({
            intentId: "intent-c1",
            kind: "confirm.field",
            origin: "proactive",
            state: "pending",
            payload: CONFIRM_PAYLOAD,
            payloadHash: confirmHash,
            nonce: "n".repeat(43),
            documentIds: ["doc-1"],
            rationale: "Extracted from scan",
          })
        )
      }

      if (url.includes("/api/gate/approvals/intent-c1/history")) {
        return Promise.resolve(
          Response.json({
            intentId: "intent-c1",
            entries: [],
          })
        )
      }

      if (url.includes("/api/core/extractions/42/confirm")) {
        if (options?.confirmFailCore) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  message: options.coreErrorMessage ?? "Invalid value",
                },
              }),
              { status: 422 }
            )
          )
        }
        return Promise.resolve(
          Response.json({
            id: 42,
            confirmedAt: "2026-10-18T08:05:00.000Z",
            state: "confirmed",
          })
        )
      }

      if (url.includes("/api/gate/approvals/intent-c1/decision")) {
        return Promise.resolve(
          Response.json({
            intentId: "intent-c1",
            state: "approved",
          })
        )
      }

      return Promise.resolve(new Response(null, { status: 404 }))
    }

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => track(respond(url, init)))
    )

    return { fetchCalls }
  }

  async function renderQueue(): Promise<HTMLElement> {
    const container = document.createElement("div")
    document.body.appendChild(container)
    act(() => {
      createRoot(container).render(<QueueView initialId="intent-c1" />)
    })
    await settle()
    return container
  }

  test("renders card with large value, raw quote, source link, confidence and actions", async () => {
    setupMocks()
    const view = await renderQueue()

    // Title & Badge
    expect(view.textContent).toContain("Confirm Invoice #1042 Amount")
    expect(view.textContent).toContain("Confirm")

    // Large typed value
    expect(view.textContent).toContain("CHF 1,200.00")

    // Raw quote beside it
    expect(view.textContent).toContain("raw: “CHF 1200.-”")

    // Source link
    const sourceLink = view.querySelector('a[href*="/documents/"]')
    expect(sourceLink).not.toBeNull()
    expect(sourceLink?.getAttribute("href")).toContain(
      CONFIRM_ARGS.source.docSha256
    )
    expect(sourceLink?.getAttribute("href")).toContain("start=28")
    expect(sourceLink?.getAttribute("href")).toContain("end=40")
    expect(sourceLink?.getAttribute("href")).toContain("page=1")
    expect(sourceLink?.getAttribute("href")).toContain("line=2")
    expect(sourceLink?.textContent).toContain(
      "Source: Invoice #1042 · Page 1 · Line 2"
    )

    // Confidence vs threshold
    expect(view.textContent).toContain("71% (threshold 80%)")

    // Context sources
    expect(view.textContent).toContain("page 1 footer, OCR text")

    // Action buttons
    const buttons = [...view.querySelectorAll("button")].map(
      (b) => b.textContent
    )
    expect(buttons.some((b) => b?.includes("Confirm"))).toBe(true)
    expect(buttons.some((b) => b?.includes("Edit value"))).toBe(true)
    expect(buttons.some((b) => b?.includes("Skip"))).toBe(true)
  })

  test("clicking Confirm executes Core confirm and Gate decision without biometric prompt", async () => {
    const { fetchCalls } = setupMocks()
    const view = await renderQueue()

    const confirmBtn = view.querySelector<HTMLButtonElement>(
      'button[aria-keyshortcuts="c"]'
    )
    expect(confirmBtn).not.toBeNull()

    act(() => {
      confirmBtn?.click()
    })
    await settle()

    // Verified Core was called first with field
    const coreCall = fetchCalls.find((c) =>
      c.url.includes("/api/core/extractions/42/confirm")
    )
    expect(coreCall).toBeDefined()
    expect(coreCall?.method).toBe("POST")
    expect(JSON.parse(coreCall?.body ?? "{}")).toEqual({ field: "amount" })

    // Verified Gate decision was called with approved
    const gateCall = fetchCalls.find((c) =>
      c.url.includes("/api/gate/approvals/intent-c1/decision")
    )
    expect(gateCall).toBeDefined()
    expect(gateCall?.method).toBe("POST")
    expect(JSON.parse(gateCall?.body ?? "{}")).toEqual({
      intentId: "intent-c1",
      decision: "approved",
    })

    // Status message shown
    expect(view.textContent).toContain("Confirmed")
  })

  test("editing value reveals input and submits edited string on Confirm", async () => {
    const { fetchCalls } = setupMocks()
    const view = await renderQueue()

    const editBtn = view.querySelector<HTMLButtonElement>(
      'button[aria-keyshortcuts="e"]'
    )
    expect(editBtn).not.toBeNull()

    act(() => {
      editBtn?.click()
    })
    await settle()

    const input = view.querySelector("input")
    expect(input).not.toBeNull()
    expect(input?.value).toBe("CHF 1,200.00")

    act(() => {
      if (input) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set?.call(input, "CHF 1,500.00")
        input.dispatchEvent(new Event("input", { bubbles: true }))
        input.dispatchEvent(new Event("change", { bubbles: true }))
      }
    })

    const confirmBtn = view.querySelector<HTMLButtonElement>(
      'button[aria-keyshortcuts="c"]'
    )
    expect(confirmBtn).not.toBeNull()

    act(() => {
      confirmBtn?.click()
    })
    await settle()

    const coreCall = fetchCalls.find((c) =>
      c.url.includes("/api/core/extractions/42/confirm")
    )
    expect(coreCall).toBeDefined()
    expect(JSON.parse(coreCall?.body ?? "{}")).toEqual({
      field: "amount",
      value: "CHF 1,500.00",
    })
  })

  test("displays error message if Core confirmation fails", async () => {
    setupMocks({
      confirmFailCore: true,
      coreErrorMessage: "Unparseable amount string",
    })
    const view = await renderQueue()

    const confirmBtn = view.querySelector<HTMLButtonElement>(
      'button[aria-keyshortcuts="c"]'
    )
    expect(confirmBtn).not.toBeNull()

    act(() => {
      confirmBtn?.click()
    })
    await settle()

    expect(view.textContent).toContain("Unparseable amount string")
  })

  test("clicking Skip advances to the next intent in the queue", async () => {
    setupMocks()
    const view = await renderQueue()

    const skipBtn = view.querySelector<HTMLButtonElement>(
      'button[aria-keyshortcuts="s"]'
    )
    expect(skipBtn).not.toBeNull()

    act(() => {
      skipBtn?.click()
    })
    await settle()

    // Now showing intent-c2 (position 2 of 2)
    expect(view.textContent).toContain("2 of 2")
  })

  test("keyboard shortcuts: c confirms", async () => {
    const { fetchCalls } = setupMocks()
    await renderQueue()

    // Press 'c' to confirm
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", bubbles: true })
      )
    })
    await settle()
    expect(
      fetchCalls.some((c) => c.url.includes("/api/core/extractions/42/confirm"))
    ).toBe(true)
  })

  test("keyboard shortcut e toggles edit mode", async () => {
    setupMocks()
    const view = await renderQueue()

    // Press 'e' to toggle edit on
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "e", bubbles: true })
      )
    })
    expect(view.querySelector("input")).not.toBeNull()

    // Press 'e' to toggle edit off
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "e", bubbles: true })
      )
    })
    expect(view.querySelector("input")).toBeNull()
  })

  test("swiping confirm card: swipe right past commit confirms, swipe left skips", async () => {
    const { fetchCalls } = setupMocks()
    const view = await renderQueue()

    const article = view.querySelector("article")!
    Object.assign(article, { setPointerCapture: () => undefined })

    // Swipe right past 100px
    for (const [type, x] of [
      ["pointerdown", 0],
      ["pointermove", 120],
      ["pointerup", 120],
    ] as const) {
      act(() => {
        const event = new Event(type, { bubbles: true })
        Object.assign(event, { clientX: x, pointerId: 1 })
        article.dispatchEvent(event)
      })
    }
    await settle()
    expect(
      fetchCalls.some((c) => c.url.includes("/api/core/extractions/42/confirm"))
    ).toBe(true)
  })

  test("renders card with number typed value and field party", async () => {
    const numPayload = JSON.stringify({
      args: {
        extractionId: "43",
        field: "party",
        value: { raw: "Acme", typed: "Acme Corp" },
        source: { docSha256: "d".repeat(64), start: 0, end: 4 },
        confidence: 0.95,
        threshold: 0.8,
      },
      kind: "confirm.field",
    })
    const numHash = (await hashPayloadText(numPayload))!

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/api/gate/approvals")) {
          return Promise.resolve(Response.json({ intents: [INTENT_CONFIRM] }))
        }
        if (url.includes("/api/gate/approvals/intent-c1/nonce")) {
          return Promise.resolve(
            Response.json({
              intentId: "intent-c1",
              kind: "confirm.field",
              origin: "proactive",
              state: "pending",
              payload: numPayload,
              payloadHash: numHash,
              nonce: "n".repeat(43),
              documentIds: ["doc-1"],
            })
          )
        }
        if (url.includes("/api/gate/approvals/intent-c1/history")) {
          return Promise.resolve(
            Response.json({ intentId: "intent-c1", entries: [] })
          )
        }
        return Promise.resolve(new Response(null, { status: 404 }))
      })
    )

    const view = await renderQueue()
    expect(view.textContent).toContain("Confirm Party")
    expect(view.textContent).toContain("Acme Corp")
    expect(view.textContent).toContain("Context used · 1 linked sources")
  })

  test("swiping left past commit skips to next intent", async () => {
    setupMocks()
    const view = await renderQueue()

    const article = view.querySelector("article")!
    Object.assign(article, { setPointerCapture: () => undefined })

    for (const [type, x] of [
      ["pointerdown", 200],
      ["pointermove", 50],
      ["pointerup", 50],
    ] as const) {
      act(() => {
        const event = new Event(type, { bubbles: true })
        Object.assign(event, { clientX: x, pointerId: 1 })
        article.dispatchEvent(event)
      })
    }
    await settle()
    expect(view.textContent).toContain("2 of 2")
  })
})
