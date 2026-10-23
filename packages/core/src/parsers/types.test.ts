import { describe, expect, it } from "vitest"
import { DEFAULT_LIMITS, ParseFailed, resolveLimits } from "./types"

describe("resolveLimits", () => {
  it("has the issue's defaults", () => {
    expect(resolveLimits()).toEqual({
      timeoutMs: 30_000,
      heapMiB: 512,
      inputBytes: 52_428_800,
      outputChars: 5_242_880,
      pdfPages: 500,
      ocrPages: 100,
      mimeDepth: 10,
      mimeAttachments: 50,
    })
  })

  it("overrides on top of a base", () => {
    expect(
      resolveLimits({ pdfPages: 3 }, { ...DEFAULT_LIMITS, ocrPages: 7 })
    ).toMatchObject({
      pdfPages: 3,
      ocrPages: 7,
    })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %d",
    (value) => {
      expect(() => resolveLimits({ heapMiB: value })).toThrow(
        new RangeError("parse limit heapMiB must be a positive integer")
      )
    }
  )
})

describe("ParseFailed", () => {
  it("carries its reason", () => {
    const error = new ParseFailed("oversize", "too big")
    expect([error.name, error.reason, error.message]).toEqual([
      "ParseFailed",
      "oversize",
      "too big",
    ])
  })
})
