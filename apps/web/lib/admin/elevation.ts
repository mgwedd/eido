import {
  validateGateLoginOptions,
  validateGateSession,
  type ValidationResult,
} from "@eido/schemas"
import { fromBase64url } from "@/lib/approval/challenge"
import { toAssertion } from "@/lib/approval/sign"
import { callGate, type GateOutcome } from "@/lib/admin/gate"

/** `GET /auth/step-up`: when the step-up on this session ends, or null when there is none. */
export function validateElevation(
  value: unknown
): ValidationResult<{ expiresAt: string | null }> {
  if (typeof value === "object" && value !== null && "expiresAt" in value) {
    const expiresAt: unknown = value.expiresAt
    if (expiresAt === null) return { ok: true, value: { expiresAt: null } }
    if (typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt)))
      return { ok: true, value: { expiresAt } }
  }
  return { ok: false, errors: ["expiresAt must be an ISO time or null"] }
}

export function loadElevation(
  signal?: AbortSignal
): Promise<GateOutcome<{ expiresAt: string | null }>> {
  return callGate("/auth/step-up", validateElevation, { signal })
}

export type StepUpOutcome =
  | GateOutcome<{ expiresAt: string }>
  | { kind: "cancelled" }

/**
 * Steps the session up with the device passkey: a challenge from the gate, the passkey with
 * user verification, then the assertion back. The gate keeps the step-up for five minutes.
 */
export async function stepUp(): Promise<StepUpOutcome> {
  const options = await callGate(
    "/auth/step-up/options",
    validateGateLoginOptions,
    { method: "POST" }
  )
  if (options.kind !== "ok") return options
  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: fromBase64url(options.value.challenge).buffer as ArrayBuffer,
        rpId: options.value.rpId,
        userVerification: "required",
        timeout: 60_000,
      },
    })
  } catch {
    return { kind: "cancelled" }
  }
  const assertion =
    credential instanceof PublicKeyCredential
      ? toAssertion(credential)
      : undefined
  if (assertion === undefined) return { kind: "cancelled" }
  return callGate("/auth/step-up", validateGateSession, {
    method: "POST",
    body: { assertion },
  })
}

/** "4:12": the minutes and seconds left until `expiresAt`, never below 0:00. */
export function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(expiresAt) - now) / 1000)
  )
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
