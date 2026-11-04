// @vitest-environment happy-dom
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
    className,
    children,
  }: {
    href: string
    className?: string
    children: React.ReactNode
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

const intents = [
  {
    id: "intent-a",
    kind: "email.reply",
    tier: "approval",
    state: "pending",
    origin: "reactive",
    createdAt: "2026-10-17T10:00:00.000Z",
  },
]

const roots: Root[] = []

function stubGate(status: () => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("/passkey/status")) return status()
      if (url.endsWith("/approvals"))
        return Promise.resolve(Response.json({ intents }))
      return Promise.resolve(new Response("nope", { status: 503 }))
    })
  )
}

async function render() {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<QueueView />)
  })
  for (let step = 0; step < 10; step += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
}

const buttonLabels = () =>
  [...document.querySelectorAll("button")].map((b) => b.textContent ?? "")

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("Queue without a passkey", () => {
  test("links to enrolment instead of Approve when no passkey is enrolled", async () => {
    stubGate(() =>
      Promise.resolve(
        Response.json({ enrolled: false, sessionExpiresAt: null })
      )
    )
    await render()
    const link = document.querySelector('a[href="/enroll?next=%2Fqueue"]')
    expect(link?.textContent).toBe("Enrol this device")
    expect(buttonLabels().some((label) => label.startsWith("Approve"))).toBe(
      false
    )
  })

  test("keeps Approve when a passkey is enrolled", async () => {
    stubGate(() =>
      Promise.resolve(Response.json({ enrolled: true, sessionExpiresAt: null }))
    )
    await render()
    expect(document.querySelector('a[href^="/enroll"]')).toBeNull()
    expect(buttonLabels().some((label) => label.startsWith("Approve"))).toBe(
      true
    )
  })

  test("keeps Approve when the gate cannot say", async () => {
    stubGate(() => Promise.resolve(new Response("down", { status: 503 })))
    await render()
    expect(document.querySelector('a[href^="/enroll"]')).toBeNull()
    expect(buttonLabels().some((label) => label.startsWith("Approve"))).toBe(
      true
    )
  })
})
