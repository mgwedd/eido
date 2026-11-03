import {
  validateGateApiError,
  validateGateDecisionResult,
  validateGatePrepareApproval,
  type GateApiError,
  type GateDecisionRequest,
  type GateDecisionResult,
  type GatePrepareApproval,
  type GateWebAuthnAssertion,
} from "@eido/schemas"
import { buildChallenge, toBase64url } from "@/lib/approval/challenge"
import { hashPayloadText } from "@/lib/approval/canonical"

const APPROVALS_URL = "/api/gate/approvals"

/** Why an approval step failed: a code the gate sent, or one raised on the device. */
export type ApprovalFailure = {
  code:
    | GateApiError["code"]
    | "network"
    | "invalid_response"
    | "cancelled"
    | "payload_changed"
  message: string
}

export type ApprovalResult<T> =
  { ok: true; value: T } | { ok: false; error: ApprovalFailure }

function failure<T>(
  code: ApprovalFailure["code"],
  message: string
): ApprovalResult<T> {
  return { ok: false, error: { code, message } }
}

async function refusal<T>(response: Response): Promise<ApprovalResult<T>> {
  try {
    const parsed = validateGateApiError(await response.json())
    if (parsed.ok) return failure(parsed.value.code, parsed.value.message)
  } catch {
    // Not JSON: fall through to the generic failure.
  }
  return failure("invalid_response", `The gate answered ${response.status}.`)
}

const PAYLOAD_CHANGED = "The payload changed. Nothing was signed."

/**
 * Recomputes the payload hash on this device (RFC 8785 canonical JSON, SHA-256) and returns the
 * approval carrying that hash, or undefined when it differs from the gate's `payloadHash`.
 */
async function verifyPayload(
  prepared: GatePrepareApproval
): Promise<GatePrepareApproval | undefined> {
  const local = await hashPayloadText(prepared.payload)
  return local !== undefined && local === prepared.payloadHash
    ? { ...prepared, payloadHash: local }
    : undefined
}

/**
 * Asks the gate to prepare an intent for approval: the stored payload, its hash and a fresh
 * single-use nonce. The hash is recomputed here over the payload as received; when it differs
 * from the gate's the result is a `payload_changed` failure and no approval is offered. Every call replaces the previous nonce, so sign over the latest result.
 */
export async function prepareApproval(
  intentId: string,
  signal?: AbortSignal
): Promise<ApprovalResult<GatePrepareApproval>> {
  let response: Response
  try {
    response = await fetch(
      `${APPROVALS_URL}/${encodeURIComponent(intentId)}/nonce`,
      { method: "POST", cache: "no-store", signal }
    )
  } catch {
    return failure("network", "The gate could not be reached.")
  }
  if (!response.ok) return refusal(response)
  try {
    const parsed = validateGatePrepareApproval(await response.json())
    if (!parsed.ok)
      return failure(
        "invalid_response",
        "The gate sent an unreadable approval."
      )
    const verified = await verifyPayload(parsed.value)
    return verified === undefined
      ? failure("payload_changed", PAYLOAD_CHANGED)
      : { ok: true, value: verified }
  } catch {
    return failure("invalid_response", "The gate sent an unreadable approval.")
  }
}

/** The options for the Face ID prompt: verification is required, the challenge is built here. */
export async function assertionOptions(
  prepared: Pick<GatePrepareApproval, "payloadHash" | "intentId" | "nonce">,
  rpId: string
): Promise<CredentialRequestOptions> {
  const challenge = await buildChallenge(prepared)
  return {
    publicKey: {
      challenge: challenge.buffer as ArrayBuffer,
      rpId,
      userVerification: "required",
      timeout: 60_000,
    },
  }
}

export function toAssertion(
  credential: PublicKeyCredential
): GateWebAuthnAssertion | undefined {
  const response = credential.response
  if (!(response instanceof AuthenticatorAssertionResponse)) return undefined
  return {
    credentialId: toBase64url(credential.rawId),
    authenticatorData: toBase64url(response.authenticatorData),
    clientDataJSON: toBase64url(response.clientDataJSON),
    signature: toBase64url(response.signature),
  }
}

/**
 * Signs a prepared intent with the device passkey and sends the approval to the gate.
 * The nonce sent is the one in `prepared`, the one the assertion was signed over. The payload
 * is hashed again first and the challenge is built from that local hash; a payload that no
 * longer matches its hash is refused before the passkey is touched.
 */
export async function signApproval(
  unverified: GatePrepareApproval,
  signal?: AbortSignal
): Promise<ApprovalResult<GateDecisionResult>> {
  const prepared = await verifyPayload(unverified)
  if (prepared === undefined) return failure("payload_changed", PAYLOAD_CHANGED)
  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({
      ...(await assertionOptions(prepared, window.location.hostname)),
      signal,
    })
  } catch {
    return failure("cancelled", "Face ID did not complete.")
  }
  const assertion =
    credential instanceof PublicKeyCredential
      ? toAssertion(credential)
      : undefined
  if (assertion === undefined)
    return failure("cancelled", "Face ID did not complete.")

  const body: GateDecisionRequest = {
    intentId: prepared.intentId,
    decision: "approved",
    nonce: prepared.nonce,
    assertion,
  }
  let response: Response
  try {
    response = await fetch(
      `${APPROVALS_URL}/${encodeURIComponent(prepared.intentId)}/decision`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }
    )
  } catch {
    return failure("network", "The gate could not be reached.")
  }
  if (!response.ok) return refusal(response)
  try {
    const parsed = validateGateDecisionResult(await response.json())
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : failure("invalid_response", "The gate sent an unreadable result.")
  } catch {
    return failure("invalid_response", "The gate sent an unreadable result.")
  }
}
