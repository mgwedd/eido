// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AskSearch } from "../components/ask-search"
import { AskView } from "../components/ask-view"
import type { CoreApiConversationSearch } from "@eido/schemas"

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

async function flush(action: () => void | Promise<void>) {
  await act(async () => {
    await action()
  })
}

const sampleHits: CoreApiConversationSearch["hits"] = [
  {
    conversationId: "conv-1",
    turnId: "t-1",
    kind: "raw",
    snippet: "We discussed the [zebrafish] lease renewal yesterday.",
    score: -0.2,
  },
  {
    conversationId: "conv-2",
    kind: "digest",
    snippet: "Summary of discussion about [zebrafish] habitats.",
    score: -0.6,
  },
]

describe("AskSearch", () => {
  it("renders closed by default and opens when clicking trigger", async () => {
    await flush(() => {
      root.render(<AskSearch />)
    })

    const trigger = container.querySelector(
      'button[aria-label="Search past conversations"]'
    )
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain("Search conversations")
    expect(container.querySelector('[role="search"]')).toBeNull()

    await flush(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    const searchRole = container.querySelector('[role="search"]')
    expect(searchRole).not.toBeNull()
    expect(searchRole?.getAttribute("aria-label")).toBe(
      "Search past conversations"
    )

    const closeBtn = container.querySelector(
      'button[aria-label="Close search"]'
    )
    await flush(() => {
      closeBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(container.querySelector('[role="search"]')).toBeNull()
  })

  it("renders search input and allows submitting a search query", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ hits: sampleHits }))
    )
    vi.stubGlobal("fetch", fetcher)

    await flush(() => {
      root.render(<AskSearch defaultOpen />)
    })

    const input = container.querySelector(
      'input[type="search"]'
    ) as HTMLInputElement
    expect(input).not.toBeNull()

    await flush(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "zebrafish")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })

    const form = container.querySelector("form")
    await flush(() => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
    })

    expect(fetcher).toHaveBeenCalled()
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/core/conversations/search?q=zebrafish"
    )

    const results = container.querySelector('ul[aria-label="Search results"]')
    expect(results).not.toBeNull()
    const items = container.querySelectorAll(
      'ul[aria-label="Search results"] > li'
    )
    expect(items).toHaveLength(2)

    // First hit: Turn badge, snippet with highlighted mark, conversation link
    const firstItem = items[0]
    expect(firstItem?.textContent).toContain("Turn")
    expect(firstItem?.textContent).toContain("Conversation conv-1")
    const mark1 = firstItem?.querySelector("mark")
    expect(mark1?.textContent).toBe("zebrafish")
    const link1 = firstItem?.querySelector("a")
    expect(link1?.getAttribute("href")).toBe("/ask?c=conv-1#t-1")

    // Second hit: Digest badge, snippet with highlighted mark, conversation link
    const secondItem = items[1]
    expect(secondItem?.textContent).toContain("Digest")
    expect(secondItem?.textContent).toContain("Conversation conv-2")
    const mark2 = secondItem?.querySelector("mark")
    expect(mark2?.textContent).toBe("zebrafish")
    const link2 = secondItem?.querySelector("a")
    expect(link2?.getAttribute("href")).toBe("/ask?c=conv-2")
  })

  it("handles empty results state", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ hits: [] }))
    )
    vi.stubGlobal("fetch", fetcher)

    await flush(() => {
      root.render(<AskSearch defaultOpen />)
    })

    const input = container.querySelector(
      'input[type="search"]'
    ) as HTMLInputElement
    await flush(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "nonexistent")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })

    const form = container.querySelector("form")
    await flush(() => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
    })

    const noMatches = container.querySelector('[role="status"]')
    expect(noMatches?.textContent).toBe("No matches found")
  })

  it("handles error state", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 500 }))
    )
    vi.stubGlobal("fetch", fetcher)

    await flush(() => {
      root.render(<AskSearch defaultOpen />)
    })

    const input = container.querySelector(
      'input[type="search"]'
    ) as HTMLInputElement
    await flush(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "error-test")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })

    const form = container.querySelector("form")
    await flush(() => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
    })

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain("Search is temporarily unavailable.")
  })

  it("filters by kind buttons", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ hits: sampleHits }))
    )
    vi.stubGlobal("fetch", fetcher)

    await flush(() => {
      root.render(<AskSearch defaultOpen />)
    })

    const input = container.querySelector(
      'input[type="search"]'
    ) as HTMLInputElement
    await flush(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "zebrafish")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })

    const turnsFilter = [...container.querySelectorAll("button")].find(
      (btn) => btn.textContent === "Turns"
    )
    await flush(() => {
      turnsFilter?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(fetcher).toHaveBeenCalled()
    expect(
      fetcher.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("kind=raw")
      )
    ).toBe(true)

    const digestsFilter = [...container.querySelectorAll("button")].find(
      (btn) => btn.textContent === "Digests"
    )
    await flush(() => {
      digestsFilter?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(
      fetcher.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("kind=digest")
      )
    ).toBe(true)
  })

  it("integrates into AskView and is accessible from the Ask page", async () => {
    await flush(() => {
      root.render(<AskView />)
    })

    const searchBtn = container.querySelector(
      'button[aria-label="Search past conversations"]'
    )
    expect(searchBtn).not.toBeNull()

    await flush(() => {
      searchBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(
      container.querySelector(
        '[role="search"][aria-label="Search past conversations"]'
      )
    ).not.toBeNull()
  })
})
