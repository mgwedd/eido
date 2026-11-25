import { expect, test } from "vitest"
import { gateConfig } from "../../main"
import { WEBAUTHN } from "../test-fixtures"

const env = {
  EIDO_GATE_DATA_DIR: "/d",
  EIDO_GATE_SOCKET: "/d/gate.sock",
  EIDO_GATE_CONTROL_SOCKET: "/d/control.sock",
  EIDO_WEBAUTHN_RP_ID: WEBAUTHN.rpId,
  EIDO_WEBAUTHN_ORIGIN: WEBAUTHN.origin,
}
const PIN = "ab".repeat(32)

test("EventKit Helper configuration is optional and names an absolute executable with its pin", () => {
  expect(gateConfig(env).appleHelper).toBeUndefined()
  expect(
    gateConfig({
      ...env,
      EIDO_EVENTKIT_HELPER: "/opt/eido/eido-helper",
      EIDO_EVENTKIT_HELPER_SHA256: PIN,
    }).appleHelper
  ).toEqual({ path: "/opt/eido/eido-helper", sha256: PIN })
  expect(() =>
    gateConfig({
      ...env,
      EIDO_EVENTKIT_HELPER: "./eido-helper",
      EIDO_EVENTKIT_HELPER_SHA256: PIN,
    })
  ).toThrow("EIDO_EVENTKIT_HELPER must be an absolute path")
})

test.each([
  [{ EIDO_EVENTKIT_HELPER: "/opt/eido/eido-helper" }],
  [{ EIDO_EVENTKIT_HELPER_SHA256: PIN }],
])("refuses a Helper path or pin set alone: %o", (partial) => {
  expect(() => gateConfig({ ...env, ...partial })).toThrow(
    "EIDO_EVENTKIT_HELPER and EIDO_EVENTKIT_HELPER_SHA256 must be set together"
  )
})

test.each(["AB".repeat(32), "ab".repeat(31), `${"ab".repeat(31)}zz`])(
  "refuses a pin that is not a lowercase SHA-256: %s",
  (sha256) => {
    expect(() =>
      gateConfig({
        ...env,
        EIDO_EVENTKIT_HELPER: "/opt/eido/eido-helper",
        EIDO_EVENTKIT_HELPER_SHA256: sha256,
      })
    ).toThrow("EIDO_EVENTKIT_HELPER_SHA256 must be a lowercase SHA-256 pin")
  }
)
