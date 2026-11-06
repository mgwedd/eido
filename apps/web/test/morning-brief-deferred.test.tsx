// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test } from "vitest"
import type { CoreApiBrief } from "@eido/schemas"
import { MorningBriefCard } from "../components/morning-brief-card"
import { NOW, briefWith } from "./fixtures/today"

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
})

function show(brief: CoreApiBrief) {
  act(() => {
    root.render(
      <MorningBriefCard
        state={{ status: "ready", brief }}
        now={NOW}
        onRetry={() => undefined}
      />
    )
  })
}

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
    ledger: { type: "extraction", id: "x1" },
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

test("extraction deferred lines are not shown", () => {
  show(briefWith(deferredLines))

  expect(container.textContent).not.toContain("Confirm total")
})

test("the Deferred label is absent when no obligation line is deferred", () => {
  show(briefWith([deferredLines[2]!]))

  expect(container.textContent).not.toContain("Deferred")
  expect(container.querySelector("ul")).toBeNull()
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
