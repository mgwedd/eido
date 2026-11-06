// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AskView } from "../components/ask-view"
import { MailSignals } from "../components/mail-signals"
import { loadMailSignals } from "../lib/mail-signals"
import { answered } from "./fixtures/ask"
import {
  CLEAN_SHA,
  FILE_SHA,
  FLAGGED_SHA,
  cleanMailCitation,
  fileCitation,
  flaggedMailCitation,
  flaggedSignals,
  markupSignals,
} from "./fixtures/mail-signals"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function settle(action: () => void = () => undefined) {
  await act(async () => {
    action()
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

function url(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url
}

describe("loadMailSignals", () => {
  test("reads the signals route and returns core's list", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ signals: flaggedSignals }))
    )
    vi.stubGlobal("fetch", fetcher)
    expect(await loadMailSignals(FLAGGED_SHA)).toEqual({
      status: "ready",
      signals: flaggedSignals,
    })
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/api/core/mail/${FLAGGED_SHA}/signals`
    )
    expect(fetcher.mock.calls[0]?.[1]?.cache).toBe("no-store")
  })

  test("a 404 means core holds no such message", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(null, { status: 404 }))
    )
    expect(await loadMailSignals(FILE_SHA)).toEqual({ status: "gone" })
  })

  test.each([
    [
      "a server error",
      () => Promise.resolve(new Response(null, { status: 500 })),
    ],
    ["a body that is not JSON", () => Promise.resolve(new Response("<html>"))],
    [
      "a body off the schema",
      () =>
        Promise.resolve(Response.json({ signals: [{ kind: "spoofed_logo" }] })),
    ],
    ["a network error", () => Promise.reject(new TypeError("offline"))],
  ])("%s fails the read", async (_name, respond) => {
    vi.stubGlobal("fetch", respond)
    expect(await loadMailSignals(FLAGGED_SHA)).toEqual({ status: "failed" })
  })

  test("an abort rejects instead of reading as failed", async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal("fetch", () =>
      Promise.reject(new DOMException("aborted", "AbortError"))
    )
    await expect(
      loadMailSignals(FLAGGED_SHA, controller.signal)
    ).rejects.toThrow("aborted")
  })
})

describe("MailSignals", () => {
  test("the chip toggles the banner", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ signals: flaggedSignals }))
    )
    await settle(() => root.render(<MailSignals sha256={FLAGGED_SHA} />))
    const chip = container.querySelector<HTMLButtonElement>(
      "button[aria-expanded]"
    )
    const banner = container.querySelector('[data-slot="alert"]')
    expect(chip?.getAttribute("aria-label")).toBe(
      "Possible phishing, 4 signals"
    )
    expect(chip?.getAttribute("aria-controls")).toBe(banner?.id)
    expect(banner?.hasAttribute("hidden")).toBe(true)
    await settle(() => chip?.click())
    expect(chip?.getAttribute("aria-expanded")).toBe("true")
    expect(banner?.hasAttribute("hidden")).toBe(false)
    await settle(() => chip?.click())
    expect(banner?.hasAttribute("hidden")).toBe(true)
  })

  test("a detail carrying markup renders as text, never as a link", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ signals: markupSignals }))
    )
    await settle(() =>
      root.render(<MailSignals sha256={FLAGGED_SHA} defaultExpanded />)
    )
    expect(container.querySelector("a")).toBeNull()
    expect(container.querySelector("code")?.textContent).toBe(
      '<a href="https://evil.example.invalid">billing@bank.example.invalid</a>'
    )
    expect(
      container
        .querySelector("button[aria-expanded]")
        ?.getAttribute("aria-label")
    ).toBe("Possible phishing, 1 signal")
  })

  test("Retry reads the signals again", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ signals: flaggedSignals }))
    vi.stubGlobal("fetch", fetcher)
    await settle(() => root.render(<MailSignals sha256={FLAGGED_SHA} />))
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry"
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't load the signals for this message."
    )
    await settle(() => retry?.click())
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector("button[aria-expanded]")?.textContent).toBe(
      "Possible phishing · 4"
    )
  })

  test("unmounting aborts the read", async () => {
    let signal: AbortSignal | null | undefined
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal
      return new Promise<Response>(() => {})
    })
    await settle(() => root.render(<MailSignals sha256={FLAGGED_SHA} />))
    await settle(() => root.render(<span />))
    expect(signal?.aborted).toBe(true)
  })
})

describe("Ask citation marks", () => {
  function stubAsk() {
    const signalsFor: Record<string, Response | undefined> = {
      [FLAGGED_SHA]: Response.json({ signals: flaggedSignals }),
      [CLEAN_SHA]: Response.json({ signals: [] }),
      [FILE_SHA]: new Response(null, { status: 404 }),
    }
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const match = /^\/api\/core\/mail\/([^/]+)\/signals$/.exec(url(input))
      if (match) {
        const response = signalsFor[match[1] ?? ""]
        if (!response) throw new Error(`Unexpected signals read: ${url(input)}`)
        return Promise.resolve(response)
      }
      return Promise.resolve(
        Response.json({
          ...answered,
          answer: "Paid [M1], quoted [M2], filed [F1].",
          citations: [flaggedMailCitation, cleanMailCitation, fileCitation],
        })
      )
    })
  }

  async function ask() {
    await settle(() => root.render(<AskView />))
    const input = container.querySelector("input")
    await settle(() => {
      if (!input) return
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "Was the roofing invoice paid?")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await settle(() =>
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        )
    )
    await settle()
  }

  test("only the flagged message's citations carry the warn mark", async () => {
    stubAsk()
    await ask()
    const marks = [
      ...container.querySelectorAll('[aria-label^="Possible phishing"]'),
    ]
    expect(marks.map((mark) => mark.getAttribute("aria-label"))).toEqual([
      "Possible phishing · 4",
      "Possible phishing · 4",
    ])
    expect(
      marks.map(
        (mark) =>
          mark.previousElementSibling?.getAttribute("aria-label") ??
          mark.closest("li")?.textContent?.includes("Re: roofing invoice")
      )
    ).toEqual(["Source M1", true])
  })

  test("tapping the mark opens its tooltip", async () => {
    stubAsk()
    await ask()
    const mark = container.querySelector<HTMLElement>(
      '[aria-label="Possible phishing · 4"]'
    )
    await settle(() => mark?.click())
    expect(
      document.querySelector('[data-slot="tooltip-content"]')?.textContent
    ).toContain("Possible phishing · 4")
  })
})
