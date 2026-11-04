import { describe, expect, test } from "vitest"
import {
  INJECTION_BUTTON_LABEL,
  INJECTION_CHIP_LABEL,
  INJECTION_PANEL_DESCRIPTION,
  INJECTION_PANEL_TITLE,
  INJECTION_REASONS,
  INJECTION_REASON_LABELS,
  isInjectionSuspected,
  normalizeInjectionReasons,
} from "../lib/injection"

describe("lib/injection", () => {
  test("constants are defined as specified", () => {
    expect(INJECTION_PANEL_TITLE).toBe("Possible injection")
    expect(INJECTION_PANEL_DESCRIPTION).toBe(
      "This item contained text that tried to pass as instructions."
    )
    expect(INJECTION_CHIP_LABEL).toBe("Possible injection")
    expect(INJECTION_BUTTON_LABEL).toBe("!")
    expect(INJECTION_REASON_LABELS["fence-tag"]).toBe("Forged fence tag")
    expect(INJECTION_REASON_LABELS["template-marker"]).toBe("Template marker")
    expect(INJECTION_REASON_LABELS["boundary-confusion"]).toBe(
      "Boundary-confusion line"
    )
    expect(INJECTION_REASON_LABELS["hidden-characters"]).toBe(
      "Hidden characters"
    )
  })

  test("normalizeInjectionReasons handles nullish, empty, unknown, and orders strictly", () => {
    expect(normalizeInjectionReasons(undefined)).toEqual([])
    expect(normalizeInjectionReasons(null)).toEqual([])
    expect(normalizeInjectionReasons([])).toEqual([])
    expect(
      normalizeInjectionReasons(["unknown-reason", "something-else"])
    ).toEqual([])
    expect(
      normalizeInjectionReasons([
        "hidden-characters",
        "boundary-confusion",
        "template-marker",
        "fence-tag",
      ])
    ).toEqual(INJECTION_REASONS)
  })

  test("isInjectionSuspected detects all input forms", () => {
    expect(isInjectionSuspected(undefined)).toBe(false)
    expect(isInjectionSuspected(null)).toBe(false)
    expect(isInjectionSuspected({})).toBe(false)
    expect(isInjectionSuspected({ injectionSuspected: false })).toBe(false)
    expect(isInjectionSuspected({ injectionSuspected: true })).toBe(true)

    expect(isInjectionSuspected({ injection: null })).toBe(false)
    expect(isInjectionSuspected({ injection: {} })).toBe(false)
    expect(isInjectionSuspected({ injection: { reasons: [] } })).toBe(false)
    expect(
      isInjectionSuspected({ injection: { reasons: ["fence-tag"] } })
    ).toBe(true)

    expect(isInjectionSuspected({ reasons: [] })).toBe(false)
    expect(isInjectionSuspected({ reasons: ["template-marker"] })).toBe(true)
  })
})
