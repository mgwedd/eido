import {
  validateGateApiError,
  validateGateCredentialStatus,
  validateGateLoginOptions,
  validateGateSession,
  type GateCredentialStatus,
} from "@eido/schemas"
import { fromBase64url } from "@/lib/approval/challenge"
import { toAssertion } from "@/lib/approval/sign"

const GATE_URL = "/api/gate"

/** Where this browser stands before any request: passkeys need the tailnet host and WebAuthn. */
export type Environment = "ok" | "wrong-origin" | "unsupported"

/** Passkeys are bound to the single `*.ts.net` host behind tailscale serve. */
export function checkEnvironment(
  hostname: string,
  hasWebAuthn: boolean
): Environment {
  if (!hasWebAuthn) return "unsupported"
  return hostname.endsWith(".ts.net") ? "ok" : "wrong-origin"
}

/**
 * The page to return to after unlocking. Only a path on this origin is followed: anything
 * else (another host, a protocol-relative URL, the unlock page itself) falls back to Today.
 */
export function safeNext(next: string | undefined): string {
  if (next === undefined) return "/"
  if (!/^\/(?![/\\])/.test(next)) return "/"
  if (/^\/unlock(?:[/?#]|$)/.test(next)) return "/"
  return next
}

export type StatusResult =
  | { ok: true; status: GateCredentialStatus }
  | { ok: false; reason: "offline" | "invalid_response" }

/** Asks the gate whether this phone has a passkey and a live session. Needs no session. */
export async function loadCredentialStatus(
  signal?: AbortSignal
): Promise<StatusResult> {
  let response: Response
  try {
    response = await fetch(`${GATE_URL}/passkey/status`, {
      cache: "no-store",
      signal,
    })
  } catch {
    return { ok: false, reason: "offline" }
  }
  if (!response.ok) return { ok: false, reason: "invalid_response" }
  try {
    const parsed = validateGateCredentialStatus(await response.json())
    return parsed.ok
      ? { ok: true, status: parsed.value }
      : { ok: false, reason: "invalid_response" }
  } catch {
    return { ok: false, reason: "invalid_response" }
  }
}

export type UnlockResult =
  | { ok: true }
  | {
      ok: false
      reason: "offline" | "cancelled" | "rejected"
      message: string
    }

const UNREADABLE = "The gate sent an answer Eido could not read."

function rejected(message: string): UnlockResult {
  return { ok: false, reason: "rejected", message }
}

async function postJson(url: string, body?: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return null
  }
}

async function refusal(response: Response): Promise<UnlockResult> {
  try {
    const parsed = validateGateApiError(await response.json())
    if (parsed.ok) return rejected(parsed.value.message)
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return rejected(`The gate answered ${response.status}.`)
}

/**
 * Signs in with the passkey on this device: fetches a login challenge from the gate, asks for
 * Face ID with user verification required, and posts the assertion. The session is the
 * HttpOnly cookie the gate sets; nothing is read back, logged or stored here.
 */
export async function unlock(): Promise<UnlockResult> {
  const optionsResponse = await postJson(`${GATE_URL}/auth/login/options`)
  if (optionsResponse === null) {
    return { ok: false, reason: "offline", message: "" }
  }
  if (!optionsResponse.ok) return refusal(optionsResponse)
  let options
  try {
    const parsed = validateGateLoginOptions(await optionsResponse.json())
    if (!parsed.ok) return rejected(UNREADABLE)
    options = parsed.value
  } catch {
    return rejected(UNREADABLE)
  }

  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: fromBase64url(options.challenge).buffer as ArrayBuffer,
        rpId: options.rpId,
        userVerification: "required",
        timeout: 60_000,
      },
    })
  } catch {
    return { ok: false, reason: "cancelled", message: "" }
  }
  const assertion =
    credential instanceof PublicKeyCredential
      ? toAssertion(credential)
      : undefined
  if (assertion === undefined) {
    return { ok: false, reason: "cancelled", message: "" }
  }

  const loginResponse = await postJson(`${GATE_URL}/auth/login`, { assertion })
  if (loginResponse === null) {
    return { ok: false, reason: "offline", message: "" }
  }
  if (!loginResponse.ok) return refusal(loginResponse)
  try {
    return validateGateSession(await loginResponse.json()).ok
      ? { ok: true }
      : rejected(UNREADABLE)
  } catch {
    return rejected(UNREADABLE)
  }
}
