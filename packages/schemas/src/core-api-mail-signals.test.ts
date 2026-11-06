import { describe, expect, test } from "vitest"
import { validateCoreApiMailSignals } from "."

// Synthetic signals only: invented domains under example.invalid.
describe("mail signals API schema", () => {
  test("a clean message's empty list is valid", () => {
    expect(validateCoreApiMailSignals({ signals: [] }).ok).toBe(true)
  })

  test("an auth signal without detail and a domain signal with one are valid", () => {
    expect(
      validateCoreApiMailSignals({
        signals: [
          { kind: "dmarc_fail" },
          { kind: "reply_to_domain", detail: "pay-desk.example.invalid" },
        ],
      }).ok
    ).toBe(true)
  })

  test("an unknown kind is rejected", () => {
    expect(
      validateCoreApiMailSignals({ signals: [{ kind: "spam_score" }] }).ok
    ).toBe(false)
  })

  test("an empty detail is rejected", () => {
    expect(
      validateCoreApiMailSignals({
        signals: [{ kind: "link_mismatch", detail: "" }],
      }).ok
    ).toBe(false)
  })

  test("an extra field on a signal is rejected", () => {
    expect(
      validateCoreApiMailSignals({
        signals: [{ kind: "spf_fail", html: "<b>x</b>" }],
      }).ok
    ).toBe(false)
  })
})
