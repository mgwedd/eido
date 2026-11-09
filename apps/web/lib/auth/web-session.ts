import { createPublicKey, verify, type KeyObject } from "node:crypto"

// Web session verification for apps/web (issue 679).
// In passkey-only mode (AUTH0_DOMAIN unset), the gate issues an Ed25519-signed JWT
// in the eido_web_session cookie (issue 678). apps/web verifies the signature using the
// gate's public key (fetched from the gate or passed via environment).

export const WEB_SESSION_COOKIE = "eido_web_session"

export type WebSessionRole = "owner"

export type WebSessionPayload = {
  readonly sub: string
  readonly role: WebSessionRole
  readonly iat: number
  readonly exp: number
}

export type VerifyWebSessionResult =
  | { readonly ok: true; readonly payload: WebSessionPayload }
  | {
      readonly ok: false
      readonly reason:
        | "malformed"
        | "invalid_signature"
        | "expired"
        | "not_yet_valid"
        | "no_key"
    }

let cachedPublicKey: KeyObject | null = null
let cachedPublicKeyRaw: string | null = null

/** Configures the raw base64url Ed25519 public key (32 bytes) in memory. */
export function setWebSessionPublicKey(rawBase64Url: string): KeyObject {
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: rawBase64Url },
    format: "jwk",
  })
  cachedPublicKey = key
  cachedPublicKeyRaw = rawBase64Url
  return key
}

/** Resets the cached public key (useful in tests). */
export function resetWebSessionPublicKey(): void {
  cachedPublicKey = null
  cachedPublicKeyRaw = null
}

/** Gets the public key from memory or EIDO_WEB_SESSION_PUBLIC_KEY env var. */
export function getWebSessionPublicKey(): KeyObject | null {
  const envKey = process.env["EIDO_WEB_SESSION_PUBLIC_KEY"]
  if (envKey && envKey !== cachedPublicKeyRaw) {
    return setWebSessionPublicKey(envKey)
  }
  return cachedPublicKey
}

/**
 * Loads the public key: returns cached key, checks env var, or fetches from gate.
 */
export async function loadWebSessionPublicKey(): Promise<KeyObject | null> {
  const existing = getWebSessionPublicKey()
  if (existing) return existing

  const gatePort = process.env["EIDO_GATE_PHONE_PORT"] ?? "8788"
  const gateHost = process.env["EIDO_GATE_PHONE_HOST"] ?? "127.0.0.1"
  try {
    const res = await fetch(`http://${gateHost}:${gatePort}/auth/jwt-key`, {
      cache: "no-store",
    })
    if (res.ok) {
      const data = (await res.json()) as { publicKey?: unknown }
      if (typeof data.publicKey === "string") {
        return setWebSessionPublicKey(data.publicKey)
      }
    }
  } catch {
    // Gate may be starting or unreachable
  }
  return null
}

/**
 * Verifies an eido_web_session compact JWT string.
 */
export function verifyWebSessionToken(
  token: string,
  key: KeyObject | null = getWebSessionPublicKey(),
  clock: () => Date = () => new Date()
): VerifyWebSessionResult {
  if (!key) {
    return { ok: false, reason: "no_key" }
  }

  const parts = token.split(".")
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed" }
  }
  const [headerB64, payloadB64, sigB64] = parts
  if (!headerB64 || !payloadB64 || !sigB64) {
    return { ok: false, reason: "malformed" }
  }

  let header: unknown
  let payload: unknown
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"))
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"))
  } catch {
    return { ok: false, reason: "malformed" }
  }

  if (
    typeof header !== "object" ||
    header === null ||
    (header as Record<string, unknown>)["alg"] !== "EdDSA" ||
    (header as Record<string, unknown>)["typ"] !== "JWT"
  ) {
    return { ok: false, reason: "malformed" }
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>)["sub"] !== "string" ||
    (payload as Record<string, unknown>)["role"] !== "owner" ||
    typeof (payload as Record<string, unknown>)["iat"] !== "number" ||
    typeof (payload as Record<string, unknown>)["exp"] !== "number"
  ) {
    return { ok: false, reason: "malformed" }
  }

  const typedPayload: WebSessionPayload = {
    sub: (payload as Record<string, string>)["sub"] as string,
    role: "owner",
    iat: (payload as Record<string, number>)["iat"] as number,
    exp: (payload as Record<string, number>)["exp"] as number,
  }

  const data = Buffer.from(`${headerB64}.${payloadB64}`, "utf8")
  const signature = Buffer.from(sigB64, "base64url")
  if (signature.length !== 64) {
    return { ok: false, reason: "invalid_signature" }
  }

  let valid = false
  try {
    valid = verify(null, data, key, signature)
  } catch {
    return { ok: false, reason: "invalid_signature" }
  }

  if (!valid) {
    return { ok: false, reason: "invalid_signature" }
  }

  const nowSec = Math.floor(clock().getTime() / 1000)
  if (typedPayload.exp <= nowSec) {
    return { ok: false, reason: "expired" }
  }
  if (typedPayload.iat > nowSec + 60) {
    return { ok: false, reason: "not_yet_valid" }
  }

  return { ok: true, payload: typedPayload }
}
