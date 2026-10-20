import { describe, expect, test } from "vitest"
import {
  extractionCandidatesJsonSchema,
  parseAmountField,
  parseDate,
  parseDueDateField,
  parseMoney,
  validateExtractionCandidates,
  validateExtractedFields,
} from "../index"

const span = { start: 5, end: 16 }

describe("parseMoney", () => {
  test.each([
    ["$4,800.00", 480000],
    ["USD 4800", 480000],
    ["4800.50 USD", 480050],
    ["$ 12", 1200],
    ["$0.1", 10],
    ["USD 9,001.25", 900125],
    ["$90071992547409.91", Number.MAX_SAFE_INTEGER],
  ])("%s becomes exact minor units", (raw, amount_minor) => {
    expect(parseMoney(raw)).toEqual({
      status: "parsed",
      value: { amount_minor, currency: "USD" },
    })
  })

  test.each([
    "1.234,56",
    "4,50",
    "1.234",
    "€4",
    "EUR 4",
    "-$4",
    "$-4",
    "$100 to $200",
    "",
    "x".repeat(400),
    "not money",
    "$1,23",
    "$1.234",
    "$90071992547409.92",
    "$12 USD",
    "4,800.00",
  ])("%s fails without guessing", (raw) => {
    expect(parseMoney(raw).status).toBe("parse_failed")
  })
})

describe("parseDate", () => {
  test.each([
    ["2026-11-15", "2026-11-15"],
    ["November 15, 2026", "2026-11-15"],
    ["Nov 15 2026", "2026-11-15"],
    ["15 November 2026", "2026-11-15"],
    ["11/15/2026", "2026-11-15"],
    ["Feb 29 2028", "2028-02-29"],
  ])("%s becomes %s", (raw, value) => {
    expect(parseDate(raw)).toEqual({ status: "parsed", value })
  })

  test.each([
    "03/04/2026",
    "March 2026",
    "Feb 30 2026",
    "next Friday",
    "",
    "within 30 days",
    "2026-02-30",
    "13/15/2026",
    "11/31/2026",
    "x".repeat(400),
  ])("%s fails without guessing", (raw) => {
    expect(parseDate(raw).status).toBe("parse_failed")
  })
})

test("parsers are total and deterministic across arbitrary and control-heavy strings", () => {
  let seed = 0x4a6f79
  const samples = ["\0\n\t\u001b", "\ud800", "9".repeat(10000)]
  for (let i = 0; i < 500; i++) {
    let sample = ""
    for (let j = 0; j < i % 75; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      sample += String.fromCharCode(seed % 65536)
    }
    samples.push(sample)
  }
  for (const sample of samples) {
    const money = parseMoney(sample)
    const date = parseDate(sample)
    expect(parseMoney(sample)).toEqual(money)
    expect(parseDate(sample)).toEqual(date)
  }
})

describe("extraction schemas", () => {
  const candidate = {
    nothing_found: false,
    items: [{ action: { quote: "File a report" } }],
  }

  test("the empty result is valid", () => {
    expect(
      validateExtractionCandidates({ nothing_found: true, items: [] }).ok
    ).toBe(true)
    expect(extractionCandidatesJsonSchema.properties?.items?.maxItems).toBe(20)
  })

  test.each([
    {
      ...candidate,
      items: [{ action: { quote: "File a report" }, send: true }],
    },
    { ...candidate, items: [{ action: { quote: "x".repeat(301) } }] },
    { ...candidate, items: [{ action: { quote: "" } }] },
    { ...candidate, items: [{ party: { quote: "Example" } }] },
    { ...candidate, items: Array(21).fill({ action: { quote: "File" } }) },
    { ...candidate, transfer: true },
  ])("rejects malformed candidate %#", (value) => {
    expect(validateExtractionCandidates(value).ok).toBe(false)
  })

  test("parsed and failed fields preserve exact raw and correlated value", () => {
    const amount = parseAmountField("$4,800.00", span)
    const failed = parseAmountField("4,50", span)
    const date = parseDueDateField("2026-11-15", span)
    const value = { action: { raw: "File", span }, amount, due_date: date }
    expect(amount).toEqual({
      raw: "$4,800.00",
      span,
      status: "parsed",
      value: { amount_minor: 480000, currency: "USD" },
    })
    expect(failed).toEqual({
      raw: "4,50",
      span,
      status: "parse_failed",
      value: null,
    })
    expect(validateExtractedFields(value).ok).toBe(true)
    expect(validateExtractedFields({ ...value, amount: failed }).ok).toBe(true)
    expect(
      validateExtractedFields({ ...value, amount: { ...failed, value: 450 } })
        .ok
    ).toBe(false)
  })

  test("source spans must end after they start", () => {
    const value = { action: { raw: "File", span: { start: 8, end: 8 } } }
    expect(validateExtractedFields(value)).toEqual({
      ok: false,
      errors: ["$.action.span.end: must be greater than start"],
    })
    expect(
      validateExtractedFields({
        action: { raw: "File", span: { start: -1, end: 8 } },
      }).ok
    ).toBe(false)
  })

  test("reference numbers are bounded and no action can encode a send or payment", () => {
    const base = { action: { raw: "File", span } }
    expect(
      validateExtractedFields({
        ...base,
        reference_number: { raw: "R".repeat(65), span },
      }).ok
    ).toBe(false)
    expect(
      validateExtractedFields({ ...base, send: { raw: "yes", span } }).ok
    ).toBe(false)
    expect(validateExtractionCandidates({ ...candidate, pay: true }).ok).toBe(
      false
    )
  })
})
