import {
  validateGateControlPrepared,
  type GateControlPrepared,
  type GateWebAuthnAssertion,
  type ValidationResult,
} from "@eido/schemas"
import { hashPayloadText, canonicalize } from "@/lib/approval/canonical"
import { fromBase64url, toBase64url } from "@/lib/approval/challenge"
import { toAssertion } from "@/lib/approval/sign"
import { callGate, type GateOutcome } from "@/lib/admin/gate"

const decoder = new TextDecoder()

/** The RFC 8785 canonical text of a JSON value, for comparing a payload with what was asked. */
function canonicalText(value: unknown): string | undefined {
  try {
    return decoder.decode(canonicalize(value))
  } catch {
    return undefined
  }
}

/**
 * The challenge a `policy.set` control ceremony signs: SHA-256 over the canonical JSON array
 * `["eido.control.v1", purpose, target, id, payloadHash, nonce]`, base64url. The gate builds the
 * same bytes in `control-approvals.ts`.
 */
export async function controlChallenge(
  prepared: Pick<
    GateControlPrepared,
    "purpose" | "target" | "id" | "payloadHash" | "nonce"
  >
): Promise<string> {
  const text = JSON.stringify([
    "eido.control.v1",
    prepared.purpose,
    prepared.target,
    prepared.id,
    prepared.payloadHash,
    prepared.nonce,
  ])
  return toBase64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  )
}

/**
 * Checks on this device that the gate prepared exactly the change the page asked for: the
 * payload hashes to `payloadHash`, equals `expected` (canonical JSON), names `target`, and the
 * challenge is the control-ceremony hash over those values. Anything else is not signed.
 */
export async function checkPrepared(
  prepared: GateControlPrepared,
  expected: { target: string; payload: unknown }
): Promise<boolean> {
  const hash = await hashPayloadText(prepared.payload)
  if (hash === undefined || hash !== prepared.payloadHash) return false
  if (prepared.target !== expected.target) return false
  let received: unknown
  try {
    received = JSON.parse(prepared.payload)
  } catch {
    return false
  }
  const want = canonicalText(expected.payload)
  if (want === undefined || canonicalText(received) !== want) return false
  return (await controlChallenge(prepared)) === prepared.challenge
}

/** Asks the device passkey to sign the prepared challenge; undefined when the prompt did not complete. */
export async function signPrepared(
  prepared: GateControlPrepared,
  signal?: AbortSignal
): Promise<GateWebAuthnAssertion | undefined> {
  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: fromBase64url(prepared.challenge).buffer as ArrayBuffer,
        rpId: window.location.hostname,
        userVerification: "required",
        timeout: 60_000,
      },
      signal,
    })
  } catch {
    return undefined
  }
  return credential instanceof PublicKeyCredential
    ? toAssertion(credential)
    : undefined
}

/** A signed change as the page describes it: where to prepare, what it must say, where to send. */
export type ControlSpec<T> = {
  preparePath: string
  prepareBody?: unknown
  target: string
  payload: unknown
  submitPath: string
  validate: (value: unknown) => ValidationResult<T>
}

/** What preparing a signed change came to; `mismatch` means the gate prepared something else. */
export type PrepareOutcome =
  | GateOutcome<GateControlPrepared>
  | { kind: "mismatch" }

/** Prepares the change and checks it on this device before anything is shown for signing. */
export async function prepareControl(
  spec: Pick<ControlSpec<unknown>, "preparePath" | "prepareBody" | "target" | "payload">,
  pick: (value: unknown) => ValidationResult<GateControlPrepared> = validateGateControlPrepared
): Promise<PrepareOutcome> {
  const outcome = await callGate(spec.preparePath, pick, {
    method: "POST",
    body: spec.prepareBody ?? {},
  })
  if (outcome.kind !== "ok") return outcome
  return (await checkPrepared(outcome.value, spec))
    ? outcome
    : { kind: "mismatch" }
}

/** What signing and sending came to; `cancelled` means the passkey prompt did not complete. */
export type SubmitOutcome<T> = GateOutcome<T> | { kind: "cancelled" }

/**
 * Signs a checked prepared change with the passkey and sends it. `extra` is read only at send
 * time, so a secret is taken from its field at the last moment and never held in state.
 */
export async function submitControl<T>(
  prepared: GateControlPrepared,
  submitPath: string,
  validate: (value: unknown) => ValidationResult<T>,
  extra: () => Record<string, unknown> = () => ({})
): Promise<SubmitOutcome<T>> {
  const assertion = await signPrepared(prepared)
  if (assertion === undefined) return { kind: "cancelled" }
  return callGate(submitPath, validate, {
    method: "POST",
    body: {
      ...extra(),
      approval: { id: prepared.id, nonce: prepared.nonce, assertion },
    },
  })
}
