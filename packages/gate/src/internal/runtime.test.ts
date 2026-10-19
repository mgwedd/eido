import { afterEach, describe, expect, it } from "vitest"
import { kindTier, preparePolicyChange } from "./policy"
import {
  applyPolicyOverrides,
  reloadPolicy,
  runningGate,
  startGate,
  stopGate,
} from "./runtime"
import { WEBAUTHN, controlAuthorization, setup } from "./test-fixtures"
import type { Setup } from "./test-fixtures"

let current: Setup | undefined

function started(): Setup {
  current = setup()
  expect(startGate(current.db, current.options, WEBAUTHN)).toEqual([])
  return current
}

afterEach(() => {
  stopGate()
  current?.cleanup()
  current = undefined
})

describe("the running gate", () => {
  it("is not available before it starts", () => {
    expect(() => runningGate()).toThrow("the gate is not started")
  })

  it("refuses to start with an origin that is not https://<rpId>", () => {
    const s = setup()
    current = s
    expect(() =>
      startGate(s.db, s.options, {
        rpId: WEBAUTHN.rpId,
        origin: "http://eido.example.invalid",
      })
    ).toThrow("the WebAuthn origin must be https://<rpId>")
    expect(() => runningGate()).toThrow("the gate is not started")
  })

  it("starts once", () => {
    const s = started()
    expect(() => startGate(s.db, s.options, WEBAUTHN)).toThrow(
      "the gate is already started"
    )
  })

  it("applies a signed override and keeps it when a later proposal is rejected", () => {
    const s = started()
    const override = { version: 1, tiers: { "email.archive": "approval" } }
    s.writeOverlay(override)
    const prepared = preparePolicyChange(s.db, override)
    const authorization = controlAuthorization(s.db, prepared)
    expect(
      applyPolicyOverrides(override, "owner", authorization.request)
    ).toEqual([])
    expect(kindTier(s.db, runningGate().policy, "email.archive")).toEqual({
      tier: "approval",
    })
    s.writeOverlay({ version: 1, tiers: { "email.archive": "forbidden" } })
    expect(reloadPolicy()).toHaveLength(1)
    expect(kindTier(s.db, runningGate().policy, "email.archive")).toEqual({
      tier: "approval",
    })
  })
})
