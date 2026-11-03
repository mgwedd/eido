import { describe, expect, it } from "vitest"
import { parseAmountCents } from "./amounts"

describe("parseAmountCents", () => {
  it("converts decimal amounts to integer cents without floating point", () => {
    expect(parseAmountCents("-12.30")).toEqual({ ok: true, cents: -1230 })
    expect(parseAmountCents("0.07")).toEqual({ ok: true, cents: 7 })
    expect(parseAmountCents("100")).toEqual({ ok: true, cents: 10000 })
    expect(parseAmountCents("100.5")).toEqual({ ok: true, cents: 10050 })
    expect(parseAmountCents("-0.05")).toEqual({ ok: true, cents: -5 })
    expect(parseAmountCents("0")).toEqual({ ok: true, cents: 0 })
    expect(parseAmountCents("-0")).toEqual({ ok: true, cents: 0 })
    expect(parseAmountCents("+42.99")).toEqual({ ok: true, cents: 4299 })
    expect(parseAmountCents("1234567.89")).toEqual({
      ok: true,
      cents: 123456789,
    })
  })

  it("rejects malformed amount formats", () => {
    expect(parseAmountCents("12.345")).toEqual({
      ok: false,
      error: 'malformed amount string "12.345"',
    })
    expect(parseAmountCents("abc")).toEqual({
      ok: false,
      error: 'malformed amount string "abc"',
    })
    expect(parseAmountCents("")).toEqual({
      ok: false,
      error: "amount string cannot be empty",
    })
    expect(parseAmountCents("   ")).toEqual({
      ok: false,
      error: "amount string cannot be empty",
    })
    expect(parseAmountCents(".50")).toEqual({
      ok: false,
      error: 'malformed amount string ".50"',
    })
    expect(parseAmountCents("12.")).toEqual({
      ok: false,
      error: 'malformed amount string "12."',
    })
    expect(parseAmountCents("12,34")).toEqual({
      ok: false,
      error: 'malformed amount string "12,34"',
    })
    expect(parseAmountCents(null)).toEqual({
      ok: false,
      error: "amount must be a string",
    })
    expect(parseAmountCents(12.3)).toEqual({
      ok: false,
      error: "amount must be a string",
    })
  })
})
