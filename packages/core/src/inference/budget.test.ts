import { describe, expect, test } from "vitest"
import {
  assertFits,
  estimateTokens,
  requiredTokens,
  truncationSuspected,
} from "./budget"
import { PromptTooLargeError } from "./errors"

describe("estimateTokens", () => {
  test("divides characters by three and rounds up", () => {
    expect(estimateTokens("abcdef")).toBe(2)
    expect(estimateTokens("abcdefg")).toBe(3)
  })

  test("counts code points, so an astral character is one character", () => {
    // "😀" is two UTF-16 code units; counted as units, four of them would be 8 / 3 = 3 tokens.
    expect(estimateTokens("😀😀😀😀")).toBe(2)
  })

  test("takes the characters-per-token ratio from the caller", () => {
    expect(estimateTokens("abcdefgh", 4)).toBe(2)
  })
})

describe("requiredTokens", () => {
  test("adds the margin to prompt and reply together", () => {
    expect(requiredTokens(900, 100)).toBe(1100)
    expect(requiredTokens(901, 100)).toBe(1102)
  })

  test("float noise does not add a token", () => {
    // 110 * 1.1 is 121.00000000000001 in floating point; the exact product is 121.
    expect(requiredTokens(100, 10)).toBe(121)
  })

  test("takes the margin ratio from the caller", () => {
    expect(requiredTokens(150, 50, 0.5)).toBe(300)
  })
})

describe("assertFits", () => {
  test("throws PromptTooLargeError carrying the three numbers", () => {
    let caught: unknown
    try {
      assertFits(901, 100, 1100)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PromptTooLargeError)
    expect(caught).toMatchObject({
      name: "PromptTooLargeError",
      estimatedPromptTokens: 901,
      requiredTokens: 1102,
      contextTokens: 1100,
    })
  })

  test("accepts a reservation exactly equal to the context", () => {
    expect(() => assertFits(900, 100, 1100)).not.toThrow()
  })
})

describe("truncationSuspected", () => {
  test("fires when the server reports under the ratio of a large estimate", () => {
    expect(truncationSuspected(1000, 599, 0.6, 500)).toBe(true)
  })

  test("does not fire at exactly the ratio", () => {
    expect(truncationSuspected(1000, 600, 0.6, 500)).toBe(false)
  })

  test("does not fire at or below the minimum estimate", () => {
    expect(truncationSuspected(500, 0, 0.6, 500)).toBe(false)
  })
})
