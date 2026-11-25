// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { CoreApiBrief } from "@eido/schemas"
import { MorningBriefCard } from "../components/morning-brief-card"
import { NOW, briefWith, confirmCardResponse } from "./fixtures/today"

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

const tick = () => new Promise((r) => setTimeout(r, 0))

function show(
  brief: CoreApiBrief,
  callbacks: {
    onOpenQueue?: (href: string) => void
    onSignedOut?: () => void
  } = {}
) {
  act(() => {
    root.render(
      <MorningBriefCard
        state={{ status: "ready", brief }}
        now={NOW}
        onRetry={() => undefined}
        onOpenQueue={callbacks.onOpenQueue ?? (() => undefined)}
        onSignedOut={callbacks.onSignedOut ?? (() => undefined)}
      />
    )
  })
}

const reply = (response: Response) =>
  vi.fn<typeof fetch>(() => Promise.resolve(response))

function bodyOf(call: Parameters<typeof fetch>): string {
  if (typeof call[1]?.body !== "string")
    throw new Error("expected a JSON string body")
  return call[1].body
}

const extractionRow = () =>
  container.querySelector<HTMLButtonElement>(
    "section[aria-labelledby='morning-brief-deferred-heading'] button"
  )

const deferredLines: CoreApiBrief["lines"] = [
  {
    kind: "deferred",
    text: "Sed do eiusmod tempor (Incididunt)",
    ledger: { type: "obligation", id: "42" },
  },
  {
    kind: "deferred",
    text: "Ut enim ad minim veniam, due 2026-11-02",
    ledger: { type: "obligation", id: "7" },
  },
  {
    kind: "deferred",
    text: 'Confirm total: "$12.00"',
    ledger: { type: "extraction", id: "17" },
  },
]

test("lists every deferred obligation line as a Ledger link, in order", () => {
  show(briefWith(deferredLines))

  const links = [
    ...container.querySelectorAll(
      "section[aria-labelledby='morning-brief-deferred-heading'] a"
    ),
  ]
  expect(
    links.map((a) => [a.getAttribute("href"), a.textContent?.trim()])
  ).toEqual([
    ["/ledger?obligation=42", "Sed do eiusmod tempor (Incididunt)"],
    ["/ledger?obligation=7", "Ut enim ad minim veniam, due 2026-11-02"],
  ])
})

test("deferred rows carry no citation chip and stay out of the brief paragraph", () => {
  show(briefWith(deferredLines))

  // Only the one cited body line has a document link.
  expect(container.querySelectorAll("a[href^='/documents/']")).toHaveLength(1)
  expect(container.querySelector("p")?.textContent).not.toContain("Sed do")
})

test("an extraction deferred line is a button in the Deferred list, after the obligation links", () => {
  show(briefWith(deferredLines))

  const rows = [
    ...container.querySelectorAll(
      "section[aria-labelledby='morning-brief-deferred-heading'] li"
    ),
  ].map((li) => li.querySelector("a, button")?.tagName)
  expect(rows).toEqual(["A", "A", "BUTTON"])
  expect(extractionRow()?.getAttribute("aria-label")).toBe(
    'Open confirm card: Confirm total: "$12.00"'
  )
})

test("the Deferred list shows when the only deferred line is an extraction one", () => {
  show(briefWith([deferredLines[2]!]))

  expect(container.textContent).toContain("Deferred")
  expect(extractionRow()?.textContent).toBe('Confirm total: "$12.00"')
})

test("an extraction line with a non-numeric id is not shown", () => {
  show(
    briefWith([
      {
        kind: "deferred",
        text: "Lorem ipsum",
        ledger: { type: "extraction", id: "x1" },
      },
    ])
  )

  expect(container.textContent).not.toContain("Deferred")
})

test("clicking an extraction line posts its id and opens the queue link core returns", async () => {
  const fetchMock = reply(Response.json(confirmCardResponse, { status: 201 }))
  vi.stubGlobal("fetch", fetchMock)
  const onOpenQueue = vi.fn()
  show(briefWith(deferredLines), { onOpenQueue })

  await act(async () => {
    extractionRow()?.click()
    await tick()
  })

  expect(JSON.parse(bodyOf(fetchMock.mock.calls[0]!))).toEqual({
    extractionId: 17,
  })
  expect(onOpenQueue).toHaveBeenCalledWith(
    "/queue?intent=intent-extraction-fixture"
  )
})

test("the row is disabled while the request is open, so a double click posts once", async () => {
  const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}))
  vi.stubGlobal("fetch", fetchMock)
  show(briefWith(deferredLines))

  await act(async () => {
    extractionRow()?.click()
    extractionRow()?.click()
    await tick()
  })

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(extractionRow()?.disabled).toBe(true)
})

test("a 401 signs the user out and does not navigate", async () => {
  vi.stubGlobal("fetch", reply(new Response(null, { status: 401 })))
  const onOpenQueue = vi.fn()
  const onSignedOut = vi.fn()
  show(briefWith(deferredLines), { onOpenQueue, onSignedOut })

  await act(async () => {
    extractionRow()?.click()
    await tick()
  })

  expect(onSignedOut).toHaveBeenCalledTimes(1)
  expect(onOpenQueue).not.toHaveBeenCalled()
})

test("a refused open stays on the page and re-enables the row", async () => {
  vi.stubGlobal(
    "fetch",
    reply(
      Response.json(
        { error: { code: "gate_unavailable", message: "Lorem ipsum" } },
        { status: 503 }
      )
    )
  )
  const onOpenQueue = vi.fn()
  const onSignedOut = vi.fn()
  show(briefWith(deferredLines), { onOpenQueue, onSignedOut })

  await act(async () => {
    extractionRow()?.click()
    await tick()
  })

  expect(onOpenQueue).not.toHaveBeenCalled()
  expect(onSignedOut).not.toHaveBeenCalled()
  expect(extractionRow()?.disabled).toBe(false)
})

test("deferred section sits above the coverage line", () => {
  show(briefWith(deferredLines))

  const text = container.textContent ?? ""
  expect(text.indexOf("Deferred")).toBeGreaterThan(
    text.indexOf("Lorem ipsum dolor sit amet.")
  )
  expect(text.indexOf("Deferred")).toBeLessThan(
    text.indexOf("Read 4 new messages")
  )
})
