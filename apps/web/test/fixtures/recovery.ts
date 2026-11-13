// Synthetic fixtures for the recovery screens. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
// The keys below are invented, not the output of any gate.
import { createHash } from "node:crypto"
import type {
  GateRecoveryCancelPrepared,
  GateRecoveryWindow,
} from "@eido/schemas"

const HOUR = 3_600_000

/** The fixed "now" every recovery fixture is measured from. */
const NOW = Date.parse("2030-01-15T12:00:00.000Z")

const iso = (ms: number) => new Date(ms).toISOString()

/** A recovery that started `startedAgoMs` ago: ready 24 h after the start, ending 24 h later. */
function windowStartedAgo(startedAgoMs: number): GateRecoveryWindow {
  const startedAt = NOW - startedAgoMs
  return {
    startedAt: iso(startedAt),
    maturesAt: iso(startedAt + 24 * HOUR),
    expiresAt: iso(startedAt + 48 * HOUR),
  }
}

const recoveryFixtures = {
  /** Started 19 minutes ago: 23 h 41 m of the delay left. */
  pending: windowStartedAgo(19 * 60_000),
  /** Started 25 hours ago: past the delay, inside the completion window. */
  matured: windowStartedAgo(25 * HOUR),
  /** Started 49 hours ago: past the completion window. */
  expired: windowStartedAgo(49 * HOUR),
} as const

const KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789"
const REPLACEMENT_KEY = "9876-5432-1ZYX-WVTS-RQPN-MKJH-GFED-CBA0"

const sha256 = (text: string) => createHash("sha256").update(text).digest()

const CANCEL_PAYLOAD = '{"action":"recovery.cancel","recoveryId":"rec-1"}'
const CANCEL_NONCE = "n".repeat(43)

/**
 * What the gate sends to prepare a cancel, built here with node:crypto from the ceremony's
 * published shape (the gate's `controlApprovalChallenge`), not with the code under test.
 */
function preparedCancel(
  over: Partial<GateRecoveryCancelPrepared> = {}
): GateRecoveryCancelPrepared {
  const payloadHash = sha256(CANCEL_PAYLOAD).toString("hex")
  const challenge = sha256(
    JSON.stringify([
      "eido.control.v1",
      "policy.set",
      "recovery_key",
      "cancel-1",
      payloadHash,
      CANCEL_NONCE,
    ])
  ).toString("base64url")
  return {
    id: "cancel-1",
    purpose: "policy.set",
    target: "recovery_key",
    payload: CANCEL_PAYLOAD,
    payloadHash,
    nonce: CANCEL_NONCE,
    challenge,
    ...over,
  }
}

/** The string body of a recorded fetch call, or "" when it sent none. */
function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : ""
}

export {
  CANCEL_NONCE,
  bodyText,
  KEY,
  NOW,
  REPLACEMENT_KEY,
  preparedCancel,
  recoveryFixtures,
  sha256,
}
