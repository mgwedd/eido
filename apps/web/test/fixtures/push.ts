// Synthetic fixtures for the push control in Settings. Imported by tests only; never by
// app code (enforced by the `web-test-fixtures-are-test-only` rule).
// The keys are made-up bytes of the right shape: p256dh is 0x04 then 1..64, auth is
// 0xa0..0xaf, the server key is 0x04 then 200..137. The hashes and challenge were computed
// with node:crypto over the hand-written canonical strings below and match the gate's
// `controlApprovalChallenge` for the same inputs.
import type { GatePushPrepared } from "@eido/schemas"

const endpoint = "https://push.example.invalid/send/device-1"
// Built from their byte patterns, not written out, so secret scanners do not read the
// synthetic keys as real ones.
const base64url = (bytes: number[]) => Buffer.from(bytes).toString("base64url")
const run = (length: number, from: number, step: number) =>
  Array.from({ length }, (_, i) => from + i * step)

const p256dh = base64url([0x04, ...run(64, 1, 1)])
const auth = base64url(run(16, 0xa0, 1))

const subscriptionJson: PushSubscriptionJSON = {
  endpoint,
  expirationTime: null,
  keys: { p256dh, auth },
}

const serverKey = base64url([0x04, ...run(64, 200, -1)])

// sha256 of `"https://push.example.invalid/send/device-1"`.
const endpointHash =
  "351798c6a5267573a961770727a40e7719c2ad955f7a8436f436ee67ebb3ab49"

const prepared: GatePushPrepared = {
  id: "control-0001",
  purpose: "policy.set",
  target: `push:${endpointHash}`,
  payload: `{"endpointHash":"${endpointHash}","keysHash":"ec3cfffa2df5e4c6437716bcc820efc3377bc659a2a77e1b9073ac973ec834bd","origin":"https://push.example.invalid"}`,
  payloadHash:
    "34b0342c1cf252333261ec7764c6fceadc58114cd7eacebe7a061b304539b9ee",
  nonce: "n".repeat(43),
  // sha256 of the canonical ["eido.control.v1", "policy.set", target, id, payloadHash, nonce].
  challenge: Buffer.from(
    "e3697b5776ad51d6b402d94aaa460b39dde6c591986239bd581e7622fa3fc1c4",
    "hex"
  ).toString("base64url"),
}

export { auth, endpoint, p256dh, prepared, serverKey, subscriptionJson }
