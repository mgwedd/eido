// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AskView } from "../components/ask-view"
import AskPage from "../app/(shell)/ask/page"
import { consumeAskFocus, requestAskFocus } from "../lib/shortcuts"
import { answered, noMatch, refused } from "./fixtures/ask"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLElement
let root: Root
let mounted = true
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
})
afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function flush(action: () => void) {
  await act(() => Promise.resolve().then(action))
}
async function render() {
  await flush(() => {
    root.render(<AskView />)
  })
}
async function fill(question = "Find invoice") {
  const input = container.querySelector("input")
  if (!input) throw new Error("Question input missing")
  await flush(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, question)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  return input
}
async function send(twice = false) {
  await flush(() => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    if (twice)
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        )
  })
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === text
  )
  if (!button) throw new Error(`Button missing: ${text}`)
  await flush(() => {
    button.click()
  })
}

test("page renders an empty working form, no samples or suggestions", async () => {
  await flush(() => {
    root.render(AskPage())
  })
  expect(container.querySelector("h1")?.textContent).toBe("Ask Eido")
  expect(
    container.querySelector('button[type="submit"]')?.hasAttribute("disabled")
  ).toBe(true)
  expect(container.querySelector("article")).toBeNull()
  expect(
    container.querySelector('[aria-label="Follow-up proposals"]')
  ).toBeNull()
})

test("the mobile form follows keyboard viewport resizing and removes listeners on exit", async () => {
  class Viewport extends EventTarget {
    height = window.innerHeight
    offsetTop = 0
  }
  const viewport = new Viewport()
  const remove = vi.spyOn(viewport, "removeEventListener")
  vi.stubGlobal("visualViewport", viewport)
  await render()
  expect(
    container
      .querySelector("form")
      ?.style.getPropertyValue("--ask-keyboard-inset")
  ).toBe("0px")
  await flush(() => {
    viewport.height = window.innerHeight - 300
    viewport.dispatchEvent(new Event("resize"))
  })
  expect(
    container
      .querySelector("form")
      ?.style.getPropertyValue("--ask-keyboard-inset")
  ).toBe("300px")
  await flush(() => {
    viewport.offsetTop = 30
    viewport.dispatchEvent(new Event("scroll"))
  })
  expect(
    container
      .querySelector("form")
      ?.style.getPropertyValue("--ask-keyboard-inset")
  ).toBe("270px")
  act(() => root.unmount())
  mounted = false
  expect(remove.mock.calls.map((call) => call[0])).toEqual(["resize", "scroll"])
})

test("checked citations are plain labels, unknown tags remain text, counts use metadata", async () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      Response.json({
        ...answered,
        answer: 'Paid [M1], unknown [M99]. <img src=x onerror="alert(1)">',
      })
    )
  )
  await render()
  await fill()
  await send()
  expect(container.querySelector("article")?.textContent).toContain("[M99]")
  expect(container.querySelectorAll('[aria-label="Source M1"]')).toHaveLength(2)
  expect(container.querySelector('[aria-label="Source M99"]')).toBeNull()
  expect(container.querySelector("article a")).toBeNull()
  expect(container.querySelector("img")).toBeNull()
  expect(
    [...container.querySelectorAll("dd")].map((node) => node.textContent)
  ).toEqual(["12", "1,284", "1"])
  expect(container.textContent).toContain("Count from search, not the model")
  expect(container.textContent).not.toContain("Found verbatim")
  expect(container.querySelector("input")).toBe(document.activeElement)
})

test.each([noMatch, refused])(
  "$status suppresses stale proposals, but retains coverage",
  async (result) => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json({ ...result, followUps: answered.followUps })
      )
    )
    await render()
    await fill()
    await send()
    expect(
      container.querySelector('[aria-label="Follow-up proposals"]')
    ).toBeNull()
    expect(container.textContent).toContain(
      "read 0 of 0 matching messages in full"
    )
    expect(container.textContent).not.toContain(
      "Count from search, not the model"
    )
    if (result.status === "refused")
      expect(container.textContent).toContain(
        "The matching message exceeds the context budget."
      )
  }
)

test("a running question is locked against duplicate submits and aborts on unmount", async () => {
  let requestSignal: AbortSignal | null | undefined
  const fetcher = vi.fn<typeof fetch>((_url, init) => {
    requestSignal = init?.signal
    return new Promise<Response>(() => {})
  })
  vi.stubGlobal("fetch", fetcher)
  await render()
  const input = await fill()
  await send(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(input.disabled).toBe(true)
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Reading your mail…"
  )
  act(() => root.unmount())
  mounted = false
  expect(requestSignal?.aborted).toBe(true)
})

test("retry preserves the failed question and clears stale data during replacement", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json(answered))
    .mockResolvedValueOnce(new Response(null, { status: 500 }))
  vi.stubGlobal("fetch", fetcher)
  await render()
  const input = await fill()
  await send()
  expect(input.value).toBe("Find invoice")
  expect(input).toBe(document.activeElement)
  await click("Retry")
  expect(container.querySelector("article")?.textContent).toContain(
    "The invoice was paid"
  )
  await fill("Different question")
  await send()
  expect(container.querySelector("article")).toBeNull()
  expect(
    container.querySelector('[aria-label="Follow-up proposals"]')
  ).toBeNull()
  expect(input.value).toBe("Different question")
  expect(fetcher.mock.calls.map((call) => call[1]?.body)).toEqual([
    '{"question":"Find invoice"}',
    '{"question":"Find invoice"}',
    '{"question":"Different question"}',
  ])
})

test.each([
  ["approval", "/queue", "Open Queue"],
  ["auto", "/activity", "Open Activity"],
])(
  "a %s proposal links to its returned tier without claiming execution",
  async (tier, href, link) => {
    const fetcher = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        Response.json(
          url === "/api/core/ask"
            ? answered
            : {
                id: "intent-1",
                tier,
                state: tier === "auto" ? "executed" : "pending",
              }
        )
      )
    )
    vi.stubGlobal("fetch", fetcher)
    await render()
    await fill()
    await send()
    await click("Archive matching emails")
    const section = container.querySelector(
      '[aria-label="Follow-up proposals"]'
    )
    expect(section?.textContent).toContain("Proposed")
    expect(section?.querySelector("a")?.getAttribute("href")).toBe(href)
    expect(section?.querySelector("a")?.textContent).toBe(link)
    expect(section?.querySelector("button")).toBeNull()
    expect(section?.textContent).not.toMatch(/done|executed|completed|undo/i)
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/core/ask",
      "/api/core/intents",
    ])
  }
)

test("pending proposals lock every control and cannot be submitted twice", async () => {
  let complete: (response: Response) => void = () => {
    throw new Error("No pending proposal")
  }
  const fetcher = vi.fn<typeof fetch>((url) =>
    url === "/api/core/ask"
      ? Promise.resolve(Response.json(answered))
      : new Promise<Response>((resolve) => {
          complete = resolve
        })
  )
  vi.stubGlobal("fetch", fetcher)
  await render()
  await fill()
  await send()
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Archive matching emails"
  )
  if (!button) throw new Error("Proposal button missing")
  await flush(() => {
    button.click()
    button.click()
  })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(button.disabled).toBe(true)
  expect(container.querySelector("input")?.disabled).toBe(true)
  expect(container.textContent).toContain("Proposing…")
  await flush(() => {
    complete(Response.json({ id: "p", tier: "approval", state: "pending" }))
  })
  expect(container.querySelector("input")?.disabled).toBe(false)
  expect(
    container.querySelector('[aria-label="Follow-up proposals"]')?.textContent
  ).toContain("Proposed")
})

test("a failed proposal stays visible and does not report success", async () => {
  const fetcher = vi.fn<typeof fetch>((url) =>
    Promise.resolve(
      url === "/api/core/ask"
        ? Response.json(answered)
        : new Response(null, { status: 403 })
    )
  )
  vi.stubGlobal("fetch", fetcher)
  await render()
  await fill()
  await send()
  await click("Archive matching emails")
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not confirm the proposal. Check Activity before trying again."
  )
  expect(
    container
      .querySelector('[aria-label="Follow-up proposals"] a')
      ?.getAttribute("href")
  ).toBe("/activity")
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Archive matching emails"
  )
  expect(button?.disabled).toBe(true)
  await click("Archive matching emails")
  expect(fetcher).toHaveBeenCalledTimes(2)
})

async function keydown(input: HTMLInputElement, init: KeyboardEventInit) {
  await flush(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    )
  })
}

test("Cmd+Enter in the field sends the question", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(answered))
  vi.stubGlobal("fetch", fetcher)
  await render()
  const input = await fill()
  await keydown(input, { key: "Enter", metaKey: true })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(container.querySelector("article")?.textContent).toContain(
    "The invoice was paid"
  )
})

test("Ctrl+Enter sends too, and a bare letter does not", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(answered))
  vi.stubGlobal("fetch", fetcher)
  await render()
  const input = await fill()
  await keydown(input, { key: "a" })
  expect(fetcher).not.toHaveBeenCalled()
  await keydown(input, { key: "Enter", ctrlKey: true })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

test("Cmd+Enter with an empty field sends nothing", async () => {
  const fetcher = vi.fn()
  vi.stubGlobal("fetch", fetcher)
  await render()
  const input = container.querySelector("input")
  if (!input) throw new Error("Question input missing")
  await keydown(input, { key: "Enter", metaKey: true })
  expect(fetcher).not.toHaveBeenCalled()
})

test("a pending focus request from the / shortcut focuses the field on mount", async () => {
  requestAskFocus()
  await render()
  expect(container.querySelector("input")).toBe(document.activeElement)
  expect(consumeAskFocus()).toBe(false)
})

test("without a focus request the field is not focused on mount", async () => {
  await render()
  expect(container.querySelector("input")).not.toBe(document.activeElement)
})
