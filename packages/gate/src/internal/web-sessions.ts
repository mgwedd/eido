import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

// Web sessions (#678). Used by the Next web app (apps/web) and core (packages/core) to identify
// the owner on the tailnet origin without holding an Auth0 tenant (#630) or touching the gate's
// passkey session cookie (eido_gate_session, Path=/api/gate).
//
// The gate signs the web session payload ({ sub, role: "owner", iat, exp }) using an Ed25519
// keypair. The resulting token is carried in eido_web_session (Path=/; HttpOnly; Secure; SameSite=Lax).
// It grants zero authority on /api/gate: tierRefusal reads only eido_gate_session.

export const WEB_SESSION_COOKIE = "eido_web_session"
export const WEB_SESSION_COOKIE_PATH = "/"
/** How long a web session lasts: 12 hours. */
export const WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1000
const GATE_SESSION_COOKIE = "eido_gate_session"
const GATE_SESSION_COOKIE_PATH = "/api/gate"

export type WebSessionRole = "owner"

export type WebSessionPayload = {
  sub: string
  role: WebSessionRole
  iat: number
  exp: number
}

export type WebSessionClaims = WebSessionPayload

export type WebSessionKeyPair = {
  privateKey: KeyObject
  publicKey: KeyObject
  publicKeyRaw: string
}

/** Generates a fresh Ed25519 keypair for signing web session cookies. */
export function generateWebSessionKeyPair(): WebSessionKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const jwk = publicKey.export({ format: "jwk" })
  if (typeof jwk.x !== "string") {
    throw new Error("Failed to export Ed25519 public key JWK")
  }
  return {
    privateKey,
    publicKey,
    publicKeyRaw: jwk.x,
  }
}

/** Loads an Ed25519 public key from its raw 32-byte base64url string (`x` from JWK). */
export function publicKeyFromRaw(rawBase64Url: string): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: rawBase64Url },
    format: "jwk",
  })
}

interface WebSessionKeysRow {
  readonly private_key_jwk: string
  readonly public_key_jwk: string
}

/**
 * Retrieves the persistent Ed25519 keypair from SQLite, or generates and stores one
 * if none exists.
 */
export function getOrCreateWebSessionKeys(db: DatabaseSync): WebSessionKeyPair {
  const row = db
    .prepare(
      "SELECT private_key_jwk, public_key_jwk FROM web_session_keys WHERE singleton = 1"
    )
    .get() as WebSessionKeysRow | undefined
  if (row !== undefined) {
    const privJwk = JSON.parse(row.private_key_jwk) as JsonWebKey
    const pubJwk = JSON.parse(row.public_key_jwk) as JsonWebKey
    const x = typeof pubJwk.x === "string" ? pubJwk.x : ""
    return {
      privateKey: createPrivateKey({ key: privJwk, format: "jwk" }),
      publicKey: createPublicKey({ key: pubJwk, format: "jwk" }),
      publicKeyRaw: x,
    }
  }
  const generated = generateWebSessionKeyPair()
  const privJwk = generated.privateKey.export({ format: "jwk" })
  const pubJwk = generated.publicKey.export({ format: "jwk" })
  db.prepare(
    "INSERT INTO web_session_keys (singleton, private_key_jwk, public_key_jwk, created_at) VALUES (1, ?, ?, ?)"
  ).run(
    JSON.stringify(privJwk),
    JSON.stringify(pubJwk),
    new Date().toISOString()
  )
  return generated
}

/** The raw 32-byte base64url Ed25519 public key used to verify web session tokens. */
export function getWebSessionPublicKey(
  db: DatabaseSync,
  keyPair?: WebSessionKeyPair
): string {
  const keys = keyPair ?? getOrCreateWebSessionKeys(db)
  return keys.publicKeyRaw
}

/** Signs a web session payload using the gate's Ed25519 private key. */
export function signWebSession(
  payload: WebSessionPayload,
  privateKey: KeyObject
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "JWT" })
  ).toString("base64url")
  const claims = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signingInput = `${header}.${claims}`
  const signature = sign(
    null,
    Buffer.from(signingInput, "utf8"),
    privateKey
  ).toString("base64url")
  return `${signingInput}.${signature}`
}

export type WebSessionVerificationRefusal =
  "malformed" | "bad_signature" | "expired" | "not_yet_valid"

export type WebSessionVerificationResult =
  | { ok: true; payload: WebSessionPayload }
  | { ok: false; reason: WebSessionVerificationRefusal }

/**
 * Verifies an Ed25519-signed web session token.
 * Validates algorithm, signature, payload shape, and expiration against `now()`.
 */
export function verifyWebSession(
  token: string,
  publicKey: KeyObject | string,
  now: () => Date = () => new Date()
): WebSessionVerificationResult {
  const parts = token.split(".")
  if (parts.length !== 3) return { ok: false, reason: "malformed" }
  const [headerB64, claimsB64, sigB64] = parts as [string, string, string]

  let header: unknown
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"))
  } catch {
    return { ok: false, reason: "malformed" }
  }
  if (
    typeof header !== "object" ||
    header === null ||
    (header as Record<string, unknown>)["alg"] !== "EdDSA"
  ) {
    return { ok: false, reason: "malformed" }
  }

  let sig: Buffer
  try {
    sig = Buffer.from(sigB64, "base64url")
  } catch {
    return { ok: false, reason: "malformed" }
  }
  if (sig.length !== 64) return { ok: false, reason: "bad_signature" }

  const key =
    typeof publicKey === "string" ? publicKeyFromRaw(publicKey) : publicKey

  const signingInput = Buffer.from(`${headerB64}.${claimsB64}`, "utf8")
  let valid = false
  try {
    valid = verify(null, signingInput, key, sig)
  } catch {
    return { ok: false, reason: "bad_signature" }
  }
  if (!valid) return { ok: false, reason: "bad_signature" }

  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"))
  } catch {
    return { ok: false, reason: "malformed" }
  }
  if (
    typeof claims !== "object" ||
    claims === null ||
    typeof (claims as Record<string, unknown>)["sub"] !== "string" ||
    (claims as Record<string, unknown>)["role"] !== "owner" ||
    typeof (claims as Record<string, unknown>)["iat"] !== "number" ||
    typeof (claims as Record<string, unknown>)["exp"] !== "number"
  ) {
    return { ok: false, reason: "malformed" }
  }

  const payload = claims as WebSessionPayload
  const nowSec = Math.floor(now().getTime() / 1000)
  if (payload.exp <= nowSec) {
    return { ok: false, reason: "expired" }
  }
  // Allow up to 60 seconds clock skew for iat in the future
  if (payload.iat > nowSec + 60) {
    return { ok: false, reason: "not_yet_valid" }
  }

  return { ok: true, payload }
}

export function webSessionCookie(token: string): string {
  return [
    `${WEB_SESSION_COOKIE}=${token}`,
    `Max-Age=${String(WEB_SESSION_TTL_MS / 1000)}`,
    `Path=${WEB_SESSION_COOKIE_PATH}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ")
}

export function clearWebSessionCookie(): string {
  return [
    `${WEB_SESSION_COOKIE}=`,
    "Max-Age=0",
    `Path=${WEB_SESSION_COOKIE_PATH}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ")
}

export function clearGateSessionCookie(): string {
  return [
    `${GATE_SESSION_COOKIE}=`,
    "Max-Age=0",
    `Path=${GATE_SESSION_COOKIE_PATH}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ")
}
