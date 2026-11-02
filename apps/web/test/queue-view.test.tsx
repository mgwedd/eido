// @vitest-environment happy-dom
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

function stub(list: Response | Error) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      list instanceof Error ? Promise.reject(list) : Promise.resolve(list)
    )
  )
}

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(<QueueView />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("Queue states", () => {
  test("empty queue says it is clear and links back to Today", async () => {
    stub(Response.json({ intents: [] }))
    const view = await render()
    expect(view.querySelector('[role="status"]')?.textContent).toBe(
      "Queue clear. Every decision is in Activity."
    )
    expect(view.querySelector("a")?.getAttribute("href")).toBe("/")
  })

  test("gate unreachable shows an alert and Retry", async () => {
    stub(new TypeError("network"))
    const view = await render()
    expect(view.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't load the queue."
    )
    expect(view.textContent).toContain("Retry")
  })

  test("a pending intent shows its card heading and Approve stays disabled until the payload loads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith("/approvals")
            ? Response.json({ intents: queued })
            : new Response(null, { status: 500 })
        )
      )
    )
    const view = await render()
    expect(view.querySelector("article h2")?.textContent).toBe("Email · Reply")
    expect(view.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load the payload."
    )
    const approve = [...view.querySelectorAll("button")].find(
      (b) => b.textContent === "Approve"
    )
    expect(approve?.disabled).toBe(true)
  })
})
