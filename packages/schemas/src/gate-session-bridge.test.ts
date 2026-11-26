import { describe, expect, it } from "vitest"
import { validateGateSessionBridgeResponse } from "./index"

describe("the session bridge's stdout answer (#826)", () => {
  it("accepts a stdout answer and each code apps/helper/README.md lists", () => {
    expect(
      validateGateSessionBridgeResponse({
        ok: true,
        result: { stdoutBase64: "aGk=" },
      })
    ).toEqual({
      ok: true,
      value: { ok: true, result: { stdoutBase64: "aGk=" } },
    })
    for (const code of [
      "invalid_request",
      "unknown_op",
      "unknown_script",
      "frame_too_large",
      "automation_denied",
      "unavailable",
    ])
      expect(validateGateSessionBridgeResponse({ ok: false, code }).ok).toBe(
        true
      )
  })

  it.each([
    ["an unknown code", { ok: false, code: "teapot" }],
    [
      "extra result fields",
      { ok: true, result: { stdoutBase64: "", stderr: "x" } },
    ],
    ["a missing result", { ok: true }],
    [
      "a success flag that is not boolean",
      { ok: "true", result: { stdoutBase64: "" } },
    ],
    ["a failure without a code", { ok: false }],
  ])("refuses %s", (_name, value) => {
    expect(validateGateSessionBridgeResponse(value).ok).toBe(false)
  })
})
