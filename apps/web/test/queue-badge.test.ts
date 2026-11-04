import { describe, expect, test } from "vitest"
import { badgeText, queueLinkName } from "../lib/queue/badge"

describe("badgeText", () => {
  test("hides the badge at zero", () => {
    expect(badgeText(0)).toBeNull()
  })

  test("shows the count as is up to 99", () => {
    expect(badgeText(1)).toBe("1")
    expect(badgeText(99)).toBe("99")
  })

  test("caps larger counts at 99+", () => {
    expect(badgeText(100)).toBe("99+")
  })
})

describe("queueLinkName", () => {
  test("names the link with the real count, not the capped text", () => {
    expect(queueLinkName("Queue", { status: "ready", count: 3 })).toBe(
      "Queue, 3 pending"
    )
    expect(queueLinkName("Queue", { status: "ready", count: 120 })).toBe(
      "Queue, 120 pending"
    )
  })

  test("leaves the plain label when there is nothing to report", () => {
    expect(queueLinkName("Queue", { status: "ready", count: 0 })).toBe(
      undefined
    )
    expect(queueLinkName("Queue", { status: "loading" })).toBe(undefined)
    expect(queueLinkName("Queue", { status: "unreachable" })).toBe(undefined)
  })
})
