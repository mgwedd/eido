import type { DatabaseSync } from "node:sqlite"
import type { GateWebAuthnAssertion } from "@eido/schemas"
import { decodeAssertion, signCountAccepted } from "./approvals"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import { newNonce } from "./nonces"
import { atomically } from "./transaction"
import {
  checkCeremony,
  parseAuthenticatorData,
  parseClientData,
  sha256,
  verifyAssertionSignature,
} from "./webauthn"
import type { CeremonyFailure, WebAuthnConfig } from "./webauthn"

// Phone sessions (#85). The phone signs in with its enrolled passkey: the gate issues a
// single-use login challenge, checks the assertion over it like an approval (ceremony, enrolled
// and unrevoked credential, signature, sign count), and sets a 12-hour session cookie. The
// cookie value is 32 random bytes; the gate stores only its SHA-256. A session ends when it
// expires or when its credential is revoked. Every login, accepted or refused, is audited with
// hashes only. The clock is a parameter so tests can move time.

export type Clock = () => Date

/** How long a session lasts: 12 hours. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** How long a login challenge can be used: 5 minutes. */
export const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000

export const SESSION_COOKIE = "eido_gate_session"
/**
 * The cookie's Path. It is the browser-facing prefix `tailscale serve` forwards to the gate
 * (#178), whatever base path the listener itself sees, so the browser sends the cookie to the
 * gate only and never to the web app or core.
 */
export const SESSION_COOKIE_PATH = "/api/gate"

export type LoginRefusal =
  | CeremonyFailure
  | "malformed"
  | "unknown_challenge"
  | "expired_challenge"
  | "unknown_credential"
  | "revoked_credential"
  | "bad_signature"
  | "sign_count"
  | "lost_race"

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: LoginRefusal }

const hex = (value: string) => sha256(value).toString("hex")

/** Issues a single-use login challenge that expires after LOGIN_CHALLENGE_TTL_MS. */
export function beginLogin(
  db: DatabaseSync,
  now: Clock
): { challenge: string; expiresAt: Date } {
  const issued = now()
  const expiresAt = new Date(issued.getTime() + LOGIN_CHALLENGE_TTL_MS)
  const challenge = newNonce()
  db.prepare(
    "INSERT INTO login_challenges (challenge, issued_at, expires_at, used_at) VALUES (?, ?, ?, NULL)"
  ).run(challenge, issued.toISOString(), expiresAt.toISOString())
  return { challenge, expiresAt }
}

type Checked =
  | {
      ok: true
      challenge: string
      credentialId: string
      storedSignCount: number
      signCount: number
    }
  | { ok: false; reason: LoginRefusal }

function checkLogin(
  db: DatabaseSync,
  config: WebAuthnConfig,
  assertion: GateWebAuthnAssertion,
  at: Date
): Checked {
  const refuse = (reason: LoginRefusal): Checked => ({ ok: false, reason })
  const decoded = decodeAssertion(assertion)
  const clientData =
    decoded === undefined ? undefined : parseClientData(decoded.clientDataJSON)
  const authData =
    decoded === undefined
      ? undefined
      : parseAuthenticatorData(decoded.authenticatorData)
  if (
    decoded === undefined ||
    clientData === undefined ||
    authData === undefined
  ) {
    return refuse("malformed")
  }
  const challenge = db
    .prepare(
      "SELECT expires_at, used_at FROM login_challenges WHERE challenge = ?"
    )
    .get(clientData.challenge)
  if (challenge === undefined || challenge["used_at"] !== null) {
    return refuse("unknown_challenge")
  }
  if (Date.parse(String(challenge["expires_at"])) <= at.getTime()) {
    return refuse("expired_challenge")
  }
  const credential = db
    .prepare(
      "SELECT public_key, sign_count, revoked_at FROM credentials WHERE credential_id = ?"
    )
    .get(decoded.credentialId)
  if (credential === undefined) return refuse("unknown_credential")
  if (credential["revoked_at"] !== null) return refuse("revoked_credential")
  const ceremony = checkCeremony(config, "webauthn.get", clientData, authData)
  if (ceremony !== undefined) return refuse(ceremony)
  const publicKey = Buffer.from(String(credential["public_key"]), "base64url")
  if (
    !verifyAssertionSignature(
      publicKey,
      decoded.authenticatorData,
      decoded.clientDataJSON,
      decoded.signature
    )
  ) {
    return refuse("bad_signature")
  }
  const storedSignCount = Number(credential["sign_count"])
  if (!signCountAccepted(storedSignCount, authData.signCount)) {
    return refuse("sign_count")
  }
  return {
    ok: true,
    challenge: clientData.challenge,
    credentialId: decoded.credentialId,
    storedSignCount,
    signCount: authData.signCount,
  }
}

function auditLogin(
  db: DatabaseSync,
  action: string,
  outcome: string,
  credentialId: string
): void {
  append(db, {
    actor: "approver",
    action,
    target: "session",
    detailHash: payloadHash({
      outcome,
      credential_sha256: hex(credentialId),
    }),
  })
}

/**
 * Signs the phone in. In one transaction the challenge is consumed, the credential's counter
 * advanced (only if it is still the one checked and the credential is not revoked) and the
 * session stored; if anything moved since the check, nothing is written. Returns the cookie
 * value, which the gate never stores.
 */
export function login(
  db: DatabaseSync,
  config: WebAuthnConfig,
  assertion: GateWebAuthnAssertion,
  now: Clock
): LoginResult {
  const at = now()
  const checked = checkLogin(db, config, assertion, at)
  if (!checked.ok) {
    auditLogin(
      db,
      `session.login_refused.${checked.reason}`,
      checked.reason,
      assertion.credentialId
    )
    return checked
  }
  const token = newNonce()
  const expiresAt = new Date(at.getTime() + SESSION_TTL_MS)
  const created = atomically(db, () => {
    const used = db
      .prepare(
        "UPDATE login_challenges SET used_at = ? WHERE challenge = ? AND used_at IS NULL"
      )
      .run(at.toISOString(), checked.challenge)
    const counted = db
      .prepare(
        "UPDATE credentials SET sign_count = ? WHERE credential_id = ? AND sign_count = ? AND revoked_at IS NULL"
      )
      .run(checked.signCount, checked.credentialId, checked.storedSignCount)
    if (Number(used.changes) !== 1 || Number(counted.changes) !== 1) {
      return false
    }
    db.prepare(
      "INSERT INTO sessions (token_hash, credential_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run(
      hex(token),
      checked.credentialId,
      at.toISOString(),
      expiresAt.toISOString()
    )
    auditLogin(db, "session.created", "created", checked.credentialId)
    return true
  })
  if (!created) {
    auditLogin(
      db,
      "session.login_refused.lost_race",
      "lost_race",
      checked.credentialId
    )
    return { ok: false, reason: "lost_race" }
  }
  return { ok: true, token, expiresAt }
}

/** The session cookie's value from a Cookie header, or undefined. */
export function sessionToken(
  cookieHeader: string | undefined
): string | undefined {
  if (cookieHeader === undefined) return undefined
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=")
    if (separator === -1) continue
    if (part.slice(0, separator).trim() === SESSION_COOKIE) {
      const value = part.slice(separator + 1).trim()
      return value === "" ? undefined : value
    }
  }
  return undefined
}

/**
 * When the session behind `token` ends, or undefined when there is none: unknown, expired at
 * `now`, or its credential revoked.
 */
export function sessionExpiry(
  db: DatabaseSync,
  token: string | undefined,
  now: Clock
): Date | undefined {
  if (token === undefined) return undefined
  const row = db
    .prepare(
      `SELECT s.expires_at FROM sessions s JOIN credentials c ON c.credential_id = s.credential_id
       WHERE s.token_hash = ? AND c.revoked_at IS NULL`
    )
    .get(hex(token))
  if (row === undefined) return undefined
  const expiresAt = new Date(String(row["expires_at"]))
  return expiresAt.getTime() > now().getTime() ? expiresAt : undefined
}

/** The Set-Cookie value for a new session. */
export function sessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${String(SESSION_TTL_MS / 1000)}`,
    `Path=${SESSION_COOKIE_PATH}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ")
}

/** True when the gate holds at least one unrevoked passkey. */
export function hasCredential(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT 1 FROM credentials WHERE revoked_at IS NULL LIMIT 1")
      .get() !== undefined
  )
}
