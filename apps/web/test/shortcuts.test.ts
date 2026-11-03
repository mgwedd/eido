// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from "vitest"
import {
  consumeAskFocus,
  goShortcuts,
  isInteractiveTarget,
  isShortcutEvent,
  isTypingTarget,
  keysOf,
  legendGroups,
  requestAskFocus,
} from "../lib/shortcuts"

afterEach(() => {
  document.body.innerHTML = ""
})

function press(
  init: KeyboardEventInit,
  target: HTMLElement = document.body
): KeyboardEvent {
  let seen: KeyboardEvent | undefined
  const listener = (event: KeyboardEvent) => {
    seen = event
  }
  document.addEventListener("keydown", listener)
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }))
  document.removeEventListener("keydown", listener)
  if (!seen) throw new Error("no keydown seen")
  return seen
}

describe("typing targets", () => {
  test.each(["input", "textarea", "select"])("%s is a typing target", (tag) => {
    expect(isTypingTarget(document.createElement(tag))).toBe(true)
  })

  test("a button is not a typing target but is interactive", () => {
    const button = document.createElement("button")
    expect(isTypingTarget(button)).toBe(false)
    expect(isInteractiveTarget(button)).toBe(true)
  })

  test("an element inside a link is interactive", () => {
    const link = document.createElement("a")
    link.href = "/queue"
    const inner = document.createElement("span")
    link.append(inner)
    expect(isInteractiveTarget(inner)).toBe(true)
  })

  test("plain text and non-elements are neither", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false)
    expect(isInteractiveTarget(document.createElement("div"))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isInteractiveTarget(null)).toBe(false)
  })

  test("an editable element is a typing target", () => {
    const editable = document.createElement("div")
    Object.defineProperty(editable, "isContentEditable", { value: true })
    expect(isTypingTarget(editable)).toBe(true)
  })
})

describe("isShortcutEvent", () => {
  test("a bare key on the page counts", () => {
    expect(isShortcutEvent(press({ key: "j" }))).toBe(true)
  })

  test("a key typed into an input does not count", () => {
    const input = document.createElement("input")
    document.body.append(input)
    expect(isShortcutEvent(press({ key: "j" }, input))).toBe(false)
  })

  test.each([{ metaKey: true }, { ctrlKey: true }, { altKey: true }])(
    "a key with %o held does not count",
    (modifier) => {
      expect(isShortcutEvent(press({ key: "a", ...modifier }))).toBe(false)
    }
  )

  test("shift alone still counts, so ? works", () => {
    expect(isShortcutEvent(press({ key: "?", shiftKey: true }))).toBe(true)
  })

  test("a key that was already handled does not count", () => {
    expect(isShortcutEvent(press({ key: "a", cancelable: true }))).toBe(true)
    const handled = new KeyboardEvent("keydown", {
      key: "a",
      cancelable: true,
    })
    handled.preventDefault()
    expect(isShortcutEvent(handled)).toBe(false)
  })

  test("nothing counts while a dialog is open", () => {
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    document.body.append(dialog)
    expect(isShortcutEvent(press({ key: "a" }))).toBe(false)
  })
})

describe("the key map", () => {
  test("keysOf splits a sequence", () => {
    expect(keysOf("g t")).toEqual(["g", "t"])
    expect(keysOf("/")).toEqual(["/"])
  })

  test("go-to keys match the design's sidebar", () => {
    expect(goShortcuts()).toEqual([
      { key: "t", href: "/", label: "Today" },
      { key: "q", href: "/queue", label: "Queue" },
      { key: "l", href: "/ledger", label: "Ledger" },
      { key: "a", href: "/activity", label: "Activity" },
      { key: "d", href: "/documents", label: "Documents" },
      { key: "s", href: "/settings", label: "Settings" },
      { key: "p", href: "/profile", label: "Profile" },
    ])
  })

  test("the legend lists the queue keys that are built, and no edit key", () => {
    const queue = legendGroups().find((group) => group.title === "Queue")
    expect(queue?.items.map((item) => item.keys.join(" "))).toEqual([
      "j",
      "k",
      "Enter",
      "a",
      "r",
      "Esc",
    ])
  })
})

describe("ask focus request", () => {
  test("is consumed once", () => {
    expect(consumeAskFocus()).toBe(false)
    requestAskFocus()
    expect(consumeAskFocus()).toBe(true)
    expect(consumeAskFocus()).toBe(false)
  })
})
