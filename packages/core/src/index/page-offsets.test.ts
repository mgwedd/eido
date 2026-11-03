import { describe, expect, test } from "vitest"
import { pageOffsetsInBody } from "./page-offsets"

describe("pageOffsetsInBody", () => {
  test("locates each page in order, so a repeated page resolves to its own place", () => {
    const body = "same\nsame\nlast"
    const ranges = pageOffsetsInBody(body, [
      { page: 1, text: "same" },
      { page: 2, text: "same" },
      { page: 3, text: "last" },
    ])
    expect(ranges.get(1)).toEqual({ page: 1, start: 0, end: 4 })
    expect(ranges.get(2)).toEqual({ page: 2, start: 5, end: 9 })
    expect(ranges.get(3)).toEqual({ page: 3, start: 10, end: 14 })
  })

  test("gives no range to an empty page or one the body does not hold, and never guesses", () => {
    const ranges = pageOffsetsInBody("alpha\nbeta", [
      { page: 1, text: "alpha" },
      { page: 2, text: "" },
      { page: 3, text: "missing" },
      { page: 4, text: "beta" },
    ])
    expect([...ranges.keys()]).toEqual([1, 4])
    expect(ranges.get(4)).toEqual({ page: 4, start: 6, end: 10 })
  })

  test("a page that only occurs before the cursor is not found again", () => {
    const ranges = pageOffsetsInBody("beta\nalpha", [
      { page: 1, text: "alpha" },
      { page: 2, text: "beta" },
    ])
    expect([...ranges.keys()]).toEqual([1])
  })
})
