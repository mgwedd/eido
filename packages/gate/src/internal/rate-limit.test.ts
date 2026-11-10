import { expect, it } from "vitest"
import { allowAttempt } from "./rate-limit"
import type { RateState } from "./rate-limit"

it("allows `limit` attempts in a window and refuses the next", () => {
  const state: RateState = new Map()
  const results = [0, 1, 2, 3].map((t) => allowAttempt(state, "k", t, 3, 1000))
  expect(results).toEqual([true, true, true, false])
})

it("starts a new window once the old one has ended", () => {
  const state: RateState = new Map()
  for (let t = 0; t < 5; t++) allowAttempt(state, "k", t, 3, 1000)
  expect(allowAttempt(state, "k", 999, 3, 1000)).toBe(false)
  expect(allowAttempt(state, "k", 1000, 3, 1000)).toBe(true)
})

it("counts keys separately and forgets ended windows", () => {
  const state: RateState = new Map()
  allowAttempt(state, "a", 0, 1, 1000)
  expect(allowAttempt(state, "a", 1, 1, 1000)).toBe(false)
  expect(allowAttempt(state, "b", 1, 1, 1000)).toBe(true)
  allowAttempt(state, "b", 5000, 1, 1000)
  expect([...state.keys()]).toEqual(["b"])
})
