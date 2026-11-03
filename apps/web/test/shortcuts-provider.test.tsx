// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { SidebarProvider } from "@eido/ui/components/sidebar"
import { AppSidebar } from "../components/app-sidebar"
import { ShortcutsProvider } from "../components/shortcuts-provider"
import { consumeAskFocus } from "../lib/shortcuts"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const navigation = vi.hoisted(() => ({
  pathname: "/",
  push: vi.fn<(href: string) => void>(),
}))
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}))

let container: HTMLElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  navigation.pathname = "/"
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <SidebarProvider>
        <ShortcutsProvider>
          <AppSidebar />
          <input id="ask-question" />
          <input id="other" />
        </ShortcutsProvider>
      </SidebarProvider>
    )
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ""
  navigation.push.mockReset()
  consumeAskFocus()
  vi.useRealTimers()
})

function press(key: string, target: HTMLElement = document.body) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    )
  })
}

test.each([
  ["t", "/"],
  ["q", "/queue"],
  ["a", "/activity"],
  ["s", "/settings"],
  ["p", "/profile"],
])("g then %s goes to %s", (second, href) => {
  press("g")
  press(second)
  expect(navigation.push).toHaveBeenCalledExactlyOnceWith(href)
})

test("g then an unmapped key goes nowhere and the next key starts fresh", () => {
  press("g")
  press("z")
  press("q")
  expect(navigation.push).not.toHaveBeenCalled()
})

test("the second key must arrive within the timeout", () => {
  press("g")
  act(() => {
    vi.advanceTimersByTime(2000)
  })
  press("q")
  expect(navigation.push).not.toHaveBeenCalled()
})

test("typing g then q in a field never navigates", () => {
  const field = document.getElementById("other") as HTMLElement
  press("g", field)
  press("q", field)
  expect(navigation.push).not.toHaveBeenCalled()
})

test("a g typed in a field does not arm a go-to sequence", () => {
  const field = document.getElementById("other") as HTMLElement
  press("g", field)
  press("q")
  expect(navigation.push).not.toHaveBeenCalled()
})

test("/ elsewhere asks Ask to take focus and navigates there", () => {
  press("/")
  expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/ask")
  expect(consumeAskFocus()).toBe(true)
})

test("/ on Ask focuses the question field in place", () => {
  navigation.pathname = "/ask"
  act(() => {
    root.render(
      <SidebarProvider>
        <ShortcutsProvider>
          <input id="ask-question" />
        </ShortcutsProvider>
      </SidebarProvider>
    )
  })
  press("/")
  expect(document.activeElement?.id).toBe("ask-question")
  expect(navigation.push).not.toHaveBeenCalled()
})

test("? opens the legend with every working shortcut", () => {
  press("?")
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain("Keyboard shortcuts")
  expect(dialog?.textContent).toContain("Approve with passkey")
  expect(dialog?.textContent).toContain("Send question")
})

test("while the legend is open, go-to keys do nothing", () => {
  press("?")
  press("g")
  press("q")
  expect(navigation.push).not.toHaveBeenCalled()
})

test("the sidebar shows each page's key and a button opens the legend", () => {
  const keys = (href: string) =>
    [
      ...container.querySelectorAll(`a[href="${href}"] kbd[data-slot="kbd"]`),
    ].map((key) => key.textContent)
  expect(keys("/queue")).toEqual(["g", "q"])
  expect(keys("/ask")).toEqual(["/"])
  const open = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Keyboard shortcuts")
  )
  act(() => {
    open?.click()
  })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})
