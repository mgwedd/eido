import { expect, test } from "vitest"
import { gateConfig } from "../../main"
import { WEBAUTHN } from "../test-fixtures"

test("EventKit Helper configuration is optional and must name an absolute gate-side executable", () => {
  const env = {
    EIDO_GATE_DATA_DIR: "/d",
    EIDO_GATE_SOCKET: "/d/gate.sock",
    EIDO_GATE_CONTROL_SOCKET: "/d/control.sock",
    EIDO_WEBAUTHN_RP_ID: WEBAUTHN.rpId,
    EIDO_WEBAUTHN_ORIGIN: WEBAUTHN.origin,
  }
  expect(gateConfig(env).appleHelperPath).toBeUndefined()
  expect(
    gateConfig({ ...env, EIDO_EVENTKIT_HELPER: "/opt/eido/eido-helper" })
      .appleHelperPath
  ).toBe("/opt/eido/eido-helper")
  expect(() =>
    gateConfig({ ...env, EIDO_EVENTKIT_HELPER: "./eido-helper" })
  ).toThrow("EIDO_EVENTKIT_HELPER must be an absolute path")
})
