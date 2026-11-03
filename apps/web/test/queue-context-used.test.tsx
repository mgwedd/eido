// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { CoreApiDocumentList } from "@eido/schemas"
import { QueueContextUsed } from "../components/queue-context-used"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const invoice = "a".repeat(64)
const quote = "b".repeat(64)

function summary(sha256: string, name: string | null) {
  return {
    sha256,
    name,
    source: "gmail",
    sourceRef: `ref-${sha256.slice(0, 4)}`,
    mime: "message/rfc822",
    type: null,
    typeSource: null,
    entity: { id: "entity-1", kind: "property", name: "Home", tag: "home" },
    ingestedAt: "2030-01-01T00:00:00.000Z",
    occurredAt: null,
    keyFacts: [],
  } satisfies CoreApiDocumentList["documents"][number]
}

let root: Root
let container: HTMLElement

async function mount(documentIds: string[]) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<QueueContextUsed documentIds={documentIds} />)
    await flush()
  })
}

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("QueueContextUsed", () => {
  test("lists the source names and asks core for exactly those ids", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(
        Response.json({
          documents: [summary(invoice, "Water invoice"), summary(quote, null)],
          nextOffset: null,
        })
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    await mount([invoice, quote])
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/core/documents?ids=${invoice},${quote}&limit=200`
    )
    expect(container.textContent).toBe(
      "Context used · 2 sourcesWater invoice, Untitled"
    )
  })

  test("falls back to the count when the lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 503 })))
    )
    await mount([invoice, quote])
    expect(container.textContent).toBe("Context used · 2 linked sources")
  })

  test("falls back to the count when core knows none of the documents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(Response.json({ documents: [], nextOffset: null }))
      )
    )
    await mount([invoice])
    expect(container.textContent).toBe("Context used · 1 linked sources")
  })

  test("shows the count while the names load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    )
    await mount([invoice])
    expect(container.textContent).toBe("Context used · 1 linked sources")
  })

  test("draws nothing and asks nothing without documents", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await mount([])
    expect(container.textContent).toBe("")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
