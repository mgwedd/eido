import { describe, expect, test } from "vitest"
import type { RankedUnit } from "./passages"
import { compareUnits, matchingPassages, paragraphs } from "./passages"

describe("paragraphs", () => {
  test("splits on blank lines, keeps single newlines, and skips whitespace-only runs", () => {
    const body = "one\ntwo\n\n   \n\nthree"
    expect(paragraphs(body)).toEqual([
      { start: 0, end: 7 },
      { start: 14, end: 19 },
    ])
  })
})

describe("matchingPassages", () => {
  const filler = "Lorem ipsum dolor sit amet. ".repeat(30)
  const body = `${filler}\n\nThe invoice was paid.\n\n${filler}`

  test("returns the matching paragraphs of a long body", () => {
    const start = body.indexOf("The invoice")
    expect(matchingPassages(body, new Set(["invoice"]))).toEqual([
      { start, end: start + "The invoice was paid.".length },
    ])
  })

  test("a short body is read whole", () => {
    const short = "The invoice was paid.\n\nOther text."
    expect(matchingPassages(short, new Set(["invoice"]))).toBeNull()
  })

  test("no matching paragraph, or matches over half the body, read whole", () => {
    expect(matchingPassages(body, new Set(["zebra"]))).toBeNull()
    expect(matchingPassages(body, new Set(["lorem"]))).toBeNull()
  })
})

describe("compareUnits", () => {
  const unit: RankedUnit = {
    sha256: "b",
    score: 2,
    searchScore: 1,
    occurredAt: "2030-01-02T00:00:00Z",
    passage: { start: 10, end: 20 },
  }
  const order = (...units: RankedUnit[]) =>
    [...units].sort(compareUnits).map((u) => units.indexOf(u))

  test("orders by term hits, then search score, then newest, then sha256, then position", () => {
    expect(order(unit, { ...unit, score: 3 })).toEqual([1, 0])
    expect(order(unit, { ...unit, searchScore: 2 })).toEqual([1, 0])
    expect(
      order(unit, { ...unit, occurredAt: "2030-01-03T00:00:00Z" })
    ).toEqual([1, 0])
    expect(
      order(unit, { ...unit, occurredAt: "2030-01-01T00:00:00Z" })
    ).toEqual([0, 1])
    expect(order(unit, { ...unit, sha256: "a" })).toEqual([1, 0])
    expect(order(unit, { ...unit, sha256: "c" })).toEqual([0, 1])
    expect(order(unit, { ...unit, passage: { start: 0, end: 5 } })).toEqual([
      1, 0,
    ])
  })

  test("a whole document sorts as position 0 among equal passages", () => {
    const whole: RankedUnit = {
      sha256: unit.sha256,
      score: unit.score,
      searchScore: unit.searchScore,
      occurredAt: unit.occurredAt,
    }
    expect(order(unit, whole)).toEqual([1, 0])
  })
})
