import { describe, expect, test } from "vitest"
import {
  DEFAULT_TRIAGE_CONFIG,
  parseTriageOverrides,
  triageConfigFrom,
} from "./config"

describe("parseTriageOverrides", () => {
  test("accepts either or both values", () => {
    expect(parseTriageOverrides("{}")).toEqual({})
    expect(parseTriageOverrides('{"perDay":0}')).toEqual({ perDay: 0 })
    expect(parseTriageOverrides('{"perDay":9,"ledgerOnlyBelow":1}')).toEqual({
      perDay: 9,
      ledgerOnlyBelow: 1,
    })
  })

  test.each([
    "not json",
    "[]",
    "null",
    '{"perDay":1.5}',
    '{"perDay":"5"}',
    '{"perDay":-1}',
    '{"ledgerOnlyBelow":1.1}',
    '{"ledgerOnlyBelow":"0.3"}',
    '{"unknown":1}',
  ])("rejects %s", (raw) => {
    expect(() => parseTriageOverrides(raw)).toThrow("EIDO_TRIAGE_CONFIG")
  })
})

describe("triageConfigFrom", () => {
  test("starts from the defaults, applies overrides and takes the timezone", () => {
    expect(triageConfigFrom({}, "Europe/Zurich")).toEqual({
      ...DEFAULT_TRIAGE_CONFIG,
      timezone: "Europe/Zurich",
    })
    expect(
      triageConfigFrom({ perDay: 2, ledgerOnlyBelow: 0.5 }, "UTC")
    ).toMatchObject({
      cardBudget: { perDay: 2 },
      ledgerOnlyBelow: 0.5,
      timezone: "UTC",
    })
  })

  test("the default budget is 5 a day", () => {
    expect(DEFAULT_TRIAGE_CONFIG.cardBudget.perDay).toBe(5)
  })
})
