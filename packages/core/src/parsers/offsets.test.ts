import { describe, expect, it } from "vitest"
import { buildText, lookupOffset, splitLines } from "./offsets"

describe("buildText", () => {
  it("joins lines with newlines and numbers them from 1 in each section", () => {
    const { text, offsets } = buildText([
      { page: 1, lines: ["ab", "c"] },
      { page: 2, lines: ["", "def"] },
    ])
    expect(text).toBe("ab\nc\n\ndef")
    expect(offsets).toEqual([
      { offset: 0, page: 1, line: 1 },
      { offset: 3, page: 1, line: 2 },
      { offset: 5, page: 2, line: 1 },
      { offset: 6, page: 2, line: 2 },
    ])
  })

  it("is empty for no sections", () => {
    expect(buildText([])).toEqual({ text: "", offsets: [] })
  })
})

describe("lookupOffset", () => {
  const table = [
    { offset: 0, line: 1 },
    { offset: 4, line: 2 },
    { offset: 9, line: 3 },
  ]

  it.each([
    [0, 1],
    [3, 1],
    [4, 2],
    [8, 2],
    [9, 3],
    [500, 3],
  ])("offset %i is on line %i", (offset, line) => {
    expect(lookupOffset(table, offset)?.line).toBe(line)
  })

  it("is null before the first line and for an empty table", () => {
    expect(lookupOffset(table, -1)).toBeNull()
    expect(lookupOffset([], 0)).toBeNull()
  })
})

describe("splitLines", () => {
  it("splits on CRLF, CR and LF", () => {
    expect(splitLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"])
  })
})
