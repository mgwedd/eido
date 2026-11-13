import {
  validateGateApiError,
  validateGateEnrolOptions,
  validateGatePasskeyList,
  validateGateEnrolled,
  type GateEnrolOptions,
  type GateWebAuthnRegistration,
} from "@eido/schemas"
import { fromBase64url, toBase64url } from "@/lib/approval/challenge"
import { safeNext } from "@/lib/auth/unlock"

const GATE_URL = "/api/gate"

/** ES256, the only algorithm the gate accepts. */
export const ES256 = -7

/** The page to return to after enrolling: a path on this origin, never /enroll itself. */
export function safeEnrolNext(next: string | undefined): string {
  const path = safeNext(next)
  return /^\/enroll(?:[/?#]|$)/.test(path) ? "/" : path
}

/** The enrolment page, carrying the page to return to. */
export function enrolUrl(next: string): string {
  const target = safeEnrolNext(next)
  return target === "/"
    ? "/enroll"
    : `/enroll?next=${encodeURIComponent(target)}`
}

/**
 * The options for `navigator.credentials.create`: a resident, user-verified platform
 * passkey bound to this page's host, ES256 only, no attestation. `userId` is random bytes
 * made for this enrolment; the gate does not use it.
 */
export function creationOptions(
  options: Pick<GateEnrolOptions, "challenge">,
  rpId: string,
  userId: Uint8Array
): CredentialCreationOptions {
  return {
    publicKey: {
      rp: { id: rpId, name: "Eido" },
      user: {
        id: userId.buffer as ArrayBuffer,
        name: "owner",
        displayName: "Eido owner",
      },
      challenge: fromBase64url(options.challenge).buffer as ArrayBuffer,
      pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      attestation: "none",
      timeout: 60_000,
    },
  }
}

/** The registration the gate expects, or undefined when the authenticator gave no SPKI key. */
export function toRegistration(
  credential: PublicKeyCredential
): GateWebAuthnRegistration | undefined {
  const response = credential.response
  if (!(response instanceof AuthenticatorAttestationResponse)) return undefined
  const publicKey = response.getPublicKey()
  if (publicKey === null) return undefined
  return {
    credentialId: toBase64url(credential.rawId),
    clientDataJSON: toBase64url(response.clientDataJSON),
    authenticatorData: toBase64url(response.getAuthenticatorData()),
    publicKey: toBase64url(publicKey),
    publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
  }
}

export type EnrolResult =
  | { ok: true }
  | {
      ok: false
      reason: "offline" | "cancelled" | "rejected"
      message: string
    }

const UNREADABLE = "The gate sent an answer Eido could not read."

function rejected(message: string): EnrolResult {
  return { ok: false, reason: "rejected", message }
}

async function postJson(url: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch {
    return null
  }
}

async function refusal(response: Response): Promise<EnrolResult> {
  try {
    const parsed = validateGateApiError(await response.json())
    if (parsed.ok) return rejected(parsed.value.message)
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return rejected(`The gate answered ${response.status}.`)
}

/**
 * Enrols this device: asks the gate for a challenge (this consumes nothing), creates the
 * passkey, and posts the registration with the code. Nothing is retried. The
 * code, challenge and registration are only held in this call: not logged, not stored. The
 * session is the HttpOnly cookie the gate sets.
 */
export async function enrol(code: string, rpId: string): Promise<EnrolResult> {
  const optionsResponse = await postJson(`${GATE_URL}/passkey/enroll/options`, {
    code,
  })
  if (optionsResponse === null) {
    return { ok: false, reason: "offline", message: "" }
  }
  if (!optionsResponse.ok) return refusal(optionsResponse)
  let options: GateEnrolOptions
  try {
    const parsed = validateGateEnrolOptions(await optionsResponse.json())
    if (!parsed.ok) return rejected(UNREADABLE)
    options = parsed.value
  } catch {
    return rejected(UNREADABLE)
  }

  let credential: Credential | null
  try {
    credential = await navigator.credentials.create(
      creationOptions(options, rpId, crypto.getRandomValues(new Uint8Array(16)))
    )
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "AbortError")
    ) {
      return { ok: false, reason: "cancelled", message: "" }
    }
    return rejected("This device could not create a passkey.")
  }
  const registration =
    credential instanceof PublicKeyCredential
      ? toRegistration(credential)
      : undefined
  if (registration === undefined) {
    return rejected("This device could not create a passkey.")
  }

  const response = await postJson(`${GATE_URL}/passkey/enroll`, {
    code,
    registration,
  })
  if (response === null) return { ok: false, reason: "offline", message: "" }
  if (!response.ok) return refusal(response)
  try {
    return validateGateEnrolled(await response.json()).ok
      ? { ok: true }
      : rejected(UNREADABLE)
  } catch {
    return rejected(UNREADABLE)
  }
}

/** When this device's passkey was created, or null without a live session or on any failure. */
export async function loadPasskeyCreatedAt(
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const response = await fetch(`${GATE_URL}/passkeys`, {
      cache: "no-store",
      signal,
    })
    if (!response.ok) return null
    const parsed = validateGatePasskeyList(await response.json())
    if (!parsed.ok) return null
    const current = parsed.value.passkeys.find(
      (passkey) => passkey.current && passkey.revokedAt === null
    )
    return current?.createdAt ?? null
  } catch {
    return null
  }
}
