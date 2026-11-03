import {
  validateGateApiError,
  validateGateRepinPrepared,
  validateGateRepinResult,
  type GateRepinPrepared,
  type GateRepinRequest,
} from "@eido/schemas"
import { fromBase64url, toBase64url } from "@/lib/approval/challenge"
import { hashPayloadText } from "@/lib/approval/canonical"
import { toAssertion } from "@/lib/approval/sign"

/** What a re-pin attempt came to: pinned, a session that expired (401), or a message to show. */
export type RepinOutcome =
  | { ok: true }
  | { ok: false; expired: true }
  | { ok: false; expired?: undefined; message: string }

const MESSAGES = {
  network: "The gate could not be reached. Nothing was changed.",
  unreadable: "The gate sent an unreadable answer. Nothing was changed.",
  mismatch:
    "The manifest the gate prepared does not match the drift shown. Nothing was signed.",
  cancelled: "Face ID did not complete. The connector stays disabled.",
  refused: "The gate refused the signature. The old pin is unchanged.",
  unavailable: "The gate cannot re-pin this connector right now.",
} as const

const encoder = new TextEncoder()

const fail = (message: string): RepinOutcome => ({ ok: false, message })

const repinUrl = (connector: string) =>
  `/api/gate/connector-settings/${encodeURIComponent(connector)}/repin`

async function post(
  url: string,
  body: unknown,
  signal?: AbortSignal
): Promise<
  | { ok: true; json: unknown }
  | { ok: false; outcome: RepinOutcome; status?: number }
> {
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    return { ok: false, outcome: fail(MESSAGES.network) }
  }
  if (response.status === 401)
    return { ok: false, outcome: { ok: false, expired: true } }
  let json: unknown
  try {
    json = await response.json()
  } catch {
    return {
      ok: false,
      outcome: fail(response.ok ? MESSAGES.unreadable : MESSAGES.unavailable),
      status: response.status,
    }
  }
  if (response.ok) return { ok: true, json }
  const error = validateGateApiError(json)
  return {
    ok: false,
    status: response.status,
    outcome: fail(
      error.ok && response.status !== 403
        ? `The gate cannot re-pin this connector: ${error.value.message}. Nothing was changed.`
        : MESSAGES.refused
    ),
  }
}

/** Lowercase tool names of the operations in a manifest payload, or undefined if it is not one. */
function operationNames(payload: string, connector: string) {
  try {
    const manifest: unknown = JSON.parse(payload)
    if (typeof manifest !== "object" || manifest === null) return undefined
    if (Reflect.get(manifest, "name") !== connector) return undefined
    const operations: unknown = Reflect.get(manifest, "operations")
    if (!Array.isArray(operations)) return undefined
    const names = new Set<string>()
    for (const op of operations as unknown[]) {
      const name: unknown =
        typeof op === "object" && op !== null
          ? Reflect.get(op, "name")
          : undefined
      if (typeof name !== "string") return undefined
      names.add(name)
    }
    return names
  } catch {
    return undefined
  }
}

/**
 * Recomputes on this device what the gate should have prepared for this drifted connector and
 * returns the challenge to sign, or undefined when the card binds anything else: the payload
 * must hash to `payloadHash`, be this connector's manifest with every added tool and none of
 * the removed ones, and the challenge must be the control-ceremony hash over those values.
 */
export async function checkedRepinChallenge(
  connector: string,
  drift: { added: readonly string[]; removed: readonly string[] },
  prepared: GateRepinPrepared
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const hash = await hashPayloadText(prepared.payload)
  const names = operationNames(prepared.payload, connector)
  if (
    hash === undefined ||
    hash !== prepared.payloadHash ||
    prepared.target !== connector ||
    names === undefined ||
    !drift.added.every((tool) => names.has(tool)) ||
    drift.removed.some((tool) => names.has(tool))
  )
    return undefined
  const challenge = toBase64url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(
          JSON.stringify([
            "eido.control.v1",
            "manifest.pin",
            connector,
            prepared.id,
            hash,
            prepared.nonce,
          ])
        )
      )
    )
  )
  return challenge === prepared.challenge
    ? new Uint8Array(fromBase64url(challenge))
    : undefined
}

/**
 * Starts a `manifest.pin` control approval for a drift-disabled connector and signs it with the
 * device passkey. The gate changes the pin only when it verifies that signature; any refusal,
 * cancelled prompt or mismatch leaves the old pin and the connector disabled.
 */
export async function repinConnector(
  connector: string,
  drift: { added: readonly string[]; removed: readonly string[] },
  signal?: AbortSignal
): Promise<RepinOutcome> {
  const prepare = await post(repinUrl(connector), {}, signal)
  if (!prepare.ok) return prepare.outcome
  const prepared = validateGateRepinPrepared(prepare.json)
  if (!prepared.ok) return fail(MESSAGES.unreadable)
  const challenge = await checkedRepinChallenge(
    connector,
    drift,
    prepared.value
  )
  if (challenge === undefined) return fail(MESSAGES.mismatch)

  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: challenge.buffer,
        rpId: window.location.hostname,
        userVerification: "required",
        timeout: 60_000,
      },
      signal,
    })
  } catch {
    return fail(MESSAGES.cancelled)
  }
  const assertion =
    credential instanceof PublicKeyCredential
      ? toAssertion(credential)
      : undefined
  if (assertion === undefined) return fail(MESSAGES.cancelled)

  const request: GateRepinRequest = {
    id: prepared.value.id,
    nonce: prepared.value.nonce,
    assertion,
  }
  const decided = await post(`${repinUrl(connector)}/decision`, request, signal)
  if (!decided.ok) return decided.outcome
  const result = validateGateRepinResult(decided.json)
  return result.ok &&
    result.value.connector === connector &&
    result.value.manifestHash === prepared.value.payloadHash
    ? { ok: true }
    : fail(MESSAGES.unreadable)
}
