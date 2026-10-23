import { describe, expect, test } from "vitest"
import { buildText } from "../parsers/offsets"
import { parsedText } from "./extraction.test-support"
import {
  evenlySpaced,
  paragraphs,
  phraseRegExp,
  selectCandidatePassages,
} from "./prefilter"

const select = (text: string, opts: Parameters<typeof selectCandidatePassages>[2] = {}) => {
  const parsed = parsedText(text)
  return selectCandidatePassages(parsed.text, parsed.offsets, opts)
}
const spans = (text: string, opts: Parameters<typeof selectCandidatePassages>[2] = {}) =>
  select(text, opts).passages.map(({ start, end }) => [start, end])

describe("phraseRegExp", () => {
  test("matches at word starts, case-insensitively, with any whitespace inside a phrase", () => {
    const regex = phraseRegExp(["renew", "due by"])
    const hits = (text: string) => [...text.matchAll(regex ?? /$^/g)].map((m) => m[0])
    expect(hits("Renewal is DUE\n  by Friday")).toEqual(["Renew", "DUE\n  by"])
    expect(hits("a nonrenewable term, overdue by")).toEqual([])
    expect(hits("auto_renew or 2renew")).toEqual([])
  })

  test("escapes regex characters in a phrase", () => {
    const regex = phraseRegExp(["fee (late)"])
    expect(regex?.test("a fee (late) applies")).toBe(true)
    expect(phraseRegExp(["fee (late)"])?.test("a fee late applies")).toBe(false)
  })

  test("an empty phrase is refused and no phrases give no regex", () => {
    expect(() => phraseRegExp(["renew", "  "])).toThrow("a prefilter phrase is empty")
    expect(phraseRegExp([])).toBeNull()
  })
})

describe("paragraphs", () => {
  test("split at blank lines, including ones holding only spaces", () => {
    const { text, offsets } = parsedText("ab\n\ncd\n \n\nef")
    expect(paragraphs(text, offsets)).toEqual([
      [0, 2],
      [4, 6],
      [10, 12],
    ])
  })

  test("split where the source message changes, with no blank line", () => {
    const { text, offsets } = buildText([
      { messageId: "<a@example.invalid>", lines: ["x y"] },
      { messageId: "<b@example.invalid>", lines: ["z"] },
    ])
    expect(paragraphs(text, offsets)).toEqual([
      [0, 3],
      [4, 5],
    ])
  })

  test("split where the message part changes", () => {
    const { text, offsets } = buildText([
      { messageId: "<a@example.invalid>", part: "1", lines: ["one"] },
      { messageId: "<a@example.invalid>", part: "2", lines: ["two"] },
    ])
    expect(paragraphs(text, offsets)).toEqual([
      [0, 3],
      [4, 7],
    ])
  })
})

describe("evenlySpaced", () => {
  test("takes the middle of each equal slice", () => {
    expect(evenlySpaced(60, 12)).toEqual([2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57])
    expect(evenlySpaced(3, 2)).toEqual([0, 2])
    expect(evenlySpaced(3, 3)).toEqual([0, 1, 2])
  })
})

describe("selectCandidatePassages", () => {
  test("no hits give no passages", () => {
    expect(select("Nothing to see here.")).toEqual({ passages: [], total: 0 })
  })

  test("a hit gives its whole paragraph when it fits the cap", () => {
    const result = select("Intro.\n\nPlease renew by May.\n\nOutro.")
    expect(result).toEqual({
      passages: [{ start: 8, end: 28, text: "Please renew by May." }],
      total: 1,
    })
  })

  test("two hits in one paragraph give one passage", () => {
    expect(spans("Renew or terminate.\n\nOther.")).toEqual([[0, 19]])
  })

  test("a long paragraph is cut to the cap, centred on the hit and clamped to the paragraph", () => {
    const dots = (n: number) => ".".repeat(n)
    // Hit at 30, cap 20: 7 characters before the 5-character hit, 8 after.
    expect(spans(`${dots(30)}renew${dots(40)}`, { windowChars: 20 })).toEqual([[23, 43]])
    // Near the start, the window starts at the paragraph.
    expect(spans(`${dots(2)}renew${dots(40)}`, { windowChars: 20 })).toEqual([[0, 20]])
    // Near the end, the window ends at the paragraph and keeps the full cap.
    expect(spans(`${dots(40)}renew${dots(2)}`, { windowChars: 20 })).toEqual([[27, 47]])
  })

  test("overlapping windows that would exceed the cap do not overlap: the later starts where the earlier ends", () => {
    const text = `${".".repeat(30)}renew.....renew${".".repeat(30)}`
    expect(spans(text, { windowChars: 20 })).toEqual([
      [23, 43],
      [43, 53],
    ])
  })

  test("windows clamped to the same paragraph end merge", () => {
    expect(spans(`${".".repeat(30)}renew renew`, { windowChars: 20 })).toEqual([[21, 41]])
  })

  test("more windows than maxPassages are spread across the document and all are counted", () => {
    const text = Array.from({ length: 5 }, (_, i) => `P${String(i)} renew`).join("\n\n")
    const result = select(text, { maxPassages: 2 })
    expect(result.total).toBe(5)
    expect(result.passages.map((p) => p.text)).toEqual(["P1 renew", "P3 renew"])
  })

  test("the token budget lowers the count, keeping the spread; a budget below one passage gives none", () => {
    const text = ["A renew", "B renew", "C renew"].join("\n\n")
    // Each passage: ceil(7 / 3) = 3 tokens plus 10 overhead = 13.
    const two = select(text, { tokenBudget: 26, overheadTokens: 10 })
    expect(two.passages.map((p) => p.text)).toEqual(["A renew", "C renew"])
    expect(select(text, { tokenBudget: 12, overheadTokens: 10 })).toEqual({
      passages: [],
      total: 3,
    })
  })

  test("custom phrases replace the defaults", () => {
    expect(spans("Please renew.\n\nInvoice overdue.", { phrases: ["invoice"] })).toEqual([
      [15, 31],
    ])
  })

  test("a non-positive window or passage count is refused", () => {
    expect(() => select("renew", { windowChars: 0 })).toThrow(
      "windowChars must be a positive integer"
    )
    expect(() => select("renew", { maxPassages: 1.5 })).toThrow(
      "maxPassages must be a positive integer"
    )
  })
})
