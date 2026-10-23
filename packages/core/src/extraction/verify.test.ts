import { describe, expect, test } from "vitest"
import { parsedText } from "./extraction.test-support"
import {
  defaultFieldConfidence,
  locateQuote,
  spanAt,
  verifyItem,
} from "./verify"

describe("spanAt", () => {
  test("with no offset entry the span has positions only", () => {
    expect(spanAt([], 3, 7)).toEqual({ start: 3, end: 7 })
  })
})

describe("locateQuote", () => {
  const text = "renew here; renew there"
  test("an occurrence crossing the passage end does not count as inside it", () => {
    // The passage [12, 15) holds only "ren" of the second "renew".
    expect(
      locateQuote(text, "renew", { start: 12, end: 15, text: "ren" })
    ).toBe(0)
    expect(
      locateQuote(text, "renew", { start: 12, end: 23, text: "renew there" })
    ).toBe(12)
    expect(locateQuote(text, "absent", { start: 0, end: 23, text })).toBe(-1)
  })
})

describe("verifyItem", () => {
  test("a reference number over the stored limit drops the item", () => {
    const reference = `REF-${"9".repeat(70)}`
    const source = parsedText(`Please renew. ${reference}`)
    const passage = { start: 0, end: source.text.length, text: source.text }
    expect(
      verifyItem(
        {
          action: { quote: "Please renew." },
          reference_number: { quote: reference },
        },
        passage,
        source,
        0.8,
        defaultFieldConfidence
      )
    ).toEqual({ kind: "dropped" })
  })
})
