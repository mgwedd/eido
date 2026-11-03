// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { SidebarProvider } from "@eido/ui/components/sidebar"
import { AppSidebar } from "../components/app-sidebar"
import { PhoneTabBar } from "../components/phone-tab-bar"
import { QueueCountProvider } from "../components/queue-count"
import { queued } from "./fixtures/queue"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const navigation = vi.hoisted(() => ({ pathname: "/" }))
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }))
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: React.ReactNode
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

function intents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ...queued[0],
    id: `intent-${i}`,
  }))
}

function stubGate(...replies: (Response | Error)[]) {
  const fetchMock = vi.fn(() => {
    const reply = replies.length > 1 ? replies.shift() : replies[0]
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(reply?.clone())
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function tree() {
  return (
    <SidebarProvider>
      <QueueCountProvider>
        <AppSidebar />
        <PhoneTabBar />
      </QueueCountProvider>
    </SidebarProvider>
  )
}

let root: Root
let container: HTMLElement

async function mount() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(tree())
    await flush()
  })
}

function queueLinks(): HTMLAnchorElement[] {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")].filter(
    (a) => a.getAttribute("href") === "/queue"
  )
}

beforeEach(() => {
  navigation.pathname = "/"
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("Queue nav badge", () => {
  test("shows the pending count on both navs with the count in the link name", async () => {
    stubGate(Response.json({ intents: intents(3) }))
    await mount()
    const [sidebar, phone] = queueLinks()
    expect(sidebar?.getAttribute("aria-label")).toBe("Queue, 3 pending")
    expect(phone?.getAttribute("aria-label")).toBe("Queue, 3 pending")
    expect(sidebar?.textContent).toBe("Queue3")
    expect(phone?.textContent).toBe("Queue· 3")
  })

  test("hides the badge when nothing is pending", async () => {
    stubGate(Response.json({ intents: [] }))
    await mount()
    for (const link of queueLinks()) {
      expect(link.hasAttribute("aria-label")).toBe(false)
      expect(link.textContent).toBe("Queue")
    }
  })

  test("hides the badge, not a zero, when the gate is unreachable", async () => {
    stubGate(new TypeError("network"))
    await mount()
    for (const link of queueLinks()) {
      expect(link.hasAttribute("aria-label")).toBe(false)
      expect(link.textContent).toBe("Queue")
    }
  })

  test("shows a skeleton only while loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    )
    await mount()
    for (const link of queueLinks()) {
      expect(link.querySelector('[data-slot="skeleton"]')).not.toBe(null)
      expect(link.hasAttribute("aria-label")).toBe(false)
    }
  })

  test("recounts when the window regains focus", async () => {
    const gate = stubGate(
      Response.json({ intents: intents(1) }),
      Response.json({ intents: intents(2) })
    )
    await mount()
    expect(queueLinks()[0]?.getAttribute("aria-label")).toBe("Queue, 1 pending")
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await flush()
    })
    expect(gate).toHaveBeenCalledTimes(2)
    expect(queueLinks()[0]?.getAttribute("aria-label")).toBe("Queue, 2 pending")
  })

  test("recounts on navigation", async () => {
    const gate = stubGate(
      Response.json({ intents: intents(1) }),
      Response.json({ intents: [] })
    )
    await mount()
    navigation.pathname = "/queue"
    await act(async () => {
      root.render(tree())
      await flush()
    })
    expect(gate).toHaveBeenCalledTimes(2)
    expect(queueLinks()[0]?.hasAttribute("aria-label")).toBe(false)
  })
})
