// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test } from "vitest"
import { ThemeProvider } from "../components/theme-provider"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.className = ""
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <ThemeProvider>
        <input data-testid="field" />
        <div data-testid="editable" />
      </ThemeProvider>
    )
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function press(init: KeyboardEventInit, target: EventTarget = document.body) {
  return act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    )
  })
}

const isDark = () => document.documentElement.classList.contains("dark")

test("starts dark and toggles with the d key", () => {
  expect(isDark()).toBe(true)
  press({ key: "d" })
  expect(isDark()).toBe(false)
  press({ key: "D" })
  expect(isDark()).toBe(true)
})

test("ignores other keys, modifiers and repeats", () => {
  press({ key: "x" })
  press({ key: "d", metaKey: true })
  press({ key: "d", ctrlKey: true })
  press({ key: "d", altKey: true })
  press({ key: "d", repeat: true })
  expect(isDark()).toBe(true)
})

test("ignores events that were already handled", () => {
  const handled = (event: Event) => event.preventDefault()
  document.body.addEventListener("keydown", handled)
  press({ key: "d" })
  document.body.removeEventListener("keydown", handled)
  expect(isDark()).toBe(true)
})

test("does not toggle while typing in a form field", () => {
  const field = container.querySelector("input")!
  press({ key: "d" }, field)
  expect(isDark()).toBe(true)
})

test("does not toggle while typing in an editable element", () => {
  const editable = container.querySelector("[data-testid=editable]")!
  Object.defineProperty(editable, "isContentEditable", { value: true })
  press({ key: "d" }, editable)
  expect(isDark()).toBe(true)
})

test("toggles when the event target is not an element", () => {
  press({ key: "d" }, window)
  expect(isDark()).toBe(false)
})
