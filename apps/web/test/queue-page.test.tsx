import { describe, expect, test } from "vitest"
import QueuePage from "../app/(shell)/queue/page"

describe("QueuePage", () => {
  test("passes ?intent= to the view", async () => {
    const element = await QueuePage({
      searchParams: Promise.resolve({ intent: "i-1" }),
    })
    expect(element.props).toEqual({ initialId: "i-1" })
  })

  test("ignores a repeated parameter", async () => {
    const element = await QueuePage({
      searchParams: Promise.resolve({ intent: ["a", "b"] }),
    })
    expect(element.props).toEqual({ initialId: undefined })
  })
})
