import { describe, expect, test } from "vitest"
import {
  absenceReplacement,
  checkTags,
  claimsAbsence,
  coverageLabel,
  formatCount,
  noMatchAnswer,
  substitutePlaceholders,
} from "./answer"

describe("coverageLabel", () => {
  test("uses thousands separators", () => {
    expect(coverageLabel(6, 1284)).toBe(
      "read 6 of 1,284 matching messages in full"
    )
    expect(formatCount(1234567)).toBe("1,234,567")
  })
})

describe("noMatchAnswer and absenceReplacement", () => {
  test("quote the terms and format the counts", () => {
    expect(noMatchAnswer(["acme", "q3 report"], 12034)).toBe(
      'No match found for "acme", "q3 report" in 12,034 indexed messages.'
    )
    expect(absenceReplacement(1500)).toBe(
      "No match found in the 1,500 messages read in full."
    )
  })
})

describe("substitutePlaceholders", () => {
  test("replaces every placeholder, repeated ones included, and leaves other braces", () => {
    expect(
      substitutePlaceholders(
        "{matches} found, {read} read, {searched} searched, {matches} again, {other}",
        { matches: 1284, read: 6, searched: 20000 }
      )
    ).toBe("1,284 found, 6 read, 20,000 searched, 1,284 again, {other}")
  })
})

describe("checkTags", () => {
  const pack = new Set(["M1", "M2", "M3"])

  test("keeps real tags, drops invented ones with the space before them", () => {
    expect(
      checkTags("Paid [M1], not [M9]. Later [M2][M12] and [M9] again.", pack)
    ).toEqual({
      text: "Paid [M1], not. Later [M2] and again.",
      cited: ["M1", "M2"],
      dropped: ["M9", "M12"],
    })
  })

  test("a leading invented tag leaves no leading space", () => {
    expect(checkTags("[M7] Paid on Monday [M3].", pack)).toEqual({
      text: "Paid on Monday [M3].",
      cited: ["M3"],
      dropped: ["M7"],
    })
  })

  test("a zero-padded tag is not a pack tag", () => {
    expect(checkTags("See [M01].", pack).dropped).toEqual(["M01"])
  })

  test("text with no tags is unchanged", () => {
    expect(checkTags("No tags here.", pack)).toEqual({
      text: "No tags here.",
      cited: [],
      dropped: [],
    })
  })
})

describe("claimsAbsence", () => {
  test.each([
    "This never happened.",
    "The payment never occurred",
    "The meeting never took place.",
    "It did not happen.",
    "That didn't occur.",
    "The call hasn't taken place",
    "The refund doesn't exist.",
    "The meeting has never been held.",
    "There is no such invoice.",
    "Nothing like that ever happened.",
  ])("%s", (text) => {
    expect(claimsAbsence(text)).toBe(true)
  })

  test.each([
    "No match found for the invoice.",
    "The meeting happened on Monday [M1].",
    "The invoice was paid [M2].",
  ])("not: %s", (text) => {
    expect(claimsAbsence(text)).toBe(false)
  })
})
