import { describe, expect, test } from "vitest"
import { scoreEvent } from "./score"

describe("scoreEvent", () => {
  test("adds the kind weight, the due urgency, money and thread age", () => {
    // 0.5 overdue + 0.25 (due by today) + 0.15 money
    expect(scoreEvent("overdue", { daysToDue: -3, moneyPresent: true })).toBe(
      0.9
    )
    // 0.35 reply owed + 0.05 for five days of thread age
    expect(scoreEvent("reply-owed", { threadAgeDays: 5 })).toBe(0.4)
    // 0.3 due soon + 0.2 (within two days)
    expect(scoreEvent("due-soon", { daysToDue: 2 })).toBe(0.5)
    // 0.3 due soon + 0.1 (within a week)
    expect(scoreEvent("due-soon", { daysToDue: 6 })).toBe(0.4)
  })

  test("a due date beyond a week adds nothing", () => {
    expect(scoreEvent("due-soon", { daysToDue: 30 })).toBe(0.3)
  })

  test("thread age is capped", () => {
    expect(scoreEvent("waiting-on", { threadAgeDays: 400 })).toBe(0.3)
  })

  test("the score never exceeds 1", () => {
    expect(
      scoreEvent("overdue", {
        daysToDue: -1,
        moneyPresent: true,
        threadAgeDays: 100,
      })
    ).toBe(1)
  })

  test("a later due date scores lower than an earlier one", () => {
    expect(scoreEvent("due-soon", { daysToDue: 1 })).toBeGreaterThan(
      scoreEvent("due-soon", { daysToDue: 5 })
    )
  })
})
