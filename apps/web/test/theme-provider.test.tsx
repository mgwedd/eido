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

beforeEach(async () => {
  window.localStorage.clear()
  document.documentElement.className = ""
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <ThemeProvider>
        <input data-testid="field" />
        <div data-testid="editable" />
      </ThemeProvider>
    )
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function press(init: KeyboardEventInit, target: EventTarget = document.body) {
  return act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    )
  })
}

const isDark = () => document.documentElement.classList.contains("dark")

test("starts dark and toggles with the d key", async () => {
  expect(isDark()).toBe(true)
  await press({ key: "d" })
  expect(isDark()).toBe(false)
  await press({ key: "D" })
  expect(isDark()).toBe(true)
})

test("ignores other keys, modifiers and repeats", async () => {
  await press({ key: "x" })
  await press({ key: "d", metaKey: true })
  await press({ key: "d", ctrlKey: true })
  await press({ key: "d", altKey: true })
  await press({ key: "d", repeat: true })
  expect(isDark()).toBe(true)
})

test("ignores events that were already handled", async () => {
  const handled = (event: Event) => event.preventDefault()
  document.body.addEventListener("keydown", handled)
  await press({ key: "d" })
  document.body.removeEventListener("keydown", handled)
  expect(isDark()).toBe(true)
})

test("does not toggle while typing in a form field", async () => {
  const field = container.querySelector("input")!
  await press({ key: "d" }, field)
  expect(isDark()).toBe(true)
})

test("does not toggle while typing in an editable element", async () => {
  const editable = container.querySelector("[data-testid=editable]")!
  Object.defineProperty(editable, "isContentEditable", { value: true })
  await press({ key: "d" }, editable)
  expect(isDark()).toBe(true)
})

test("toggles when the event target is not an element", async () => {
  await press({ key: "d" }, window)
  expect(isDark()).toBe(false)
})
