import { requireControlState } from "./control-checkpoint"
import type { DatabaseSync } from "node:sqlite"
import type { GateWebAuthnAssertion } from "@eido/schemas"
import { decodeAssertion, signCountAccepted } from "./approvals"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import { newNonce } from "./nonces"
import { atomically } from "./transaction"
import {
  getOrCreateWebSessionKeys,
  signWebSession,
  type WebSessionKeyPair,
} from "./web-sessions"
import {
  checkCeremony,
  parseAuthenticatorData,
  parseClientData,
  sha256,
  verifyAssertionSignature,
} from "./webauthn"
import type { CeremonyFailure, WebAuthnConfig } from "./webauthn"

export {
  WEB_SESSION_COOKIE,
  WEB_SESSION_COOKIE_PATH,
  WEB_SESSION_TTL_MS,
  clearGateSessionCookie,
  clearWebSessionCookie,
  generateWebSessionKeyPair,
  getOrCreateWebSessionKeys,
  getWebSessionPublicKey,
  publicKeyFromRaw,
  signWebSession,
  verifyWebSession,
  webSessionCookie,
} from "./web-sessions"
export type {
  WebSessionClaims,
  WebSessionKeyPair,
  WebSessionPayload,
  WebSessionRole,
  WebSessionVerificationRefusal,
  WebSessionVerificationResult,
} from "./web-sessions"

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
  | { ok: true; token: string; webSessionToken: string; expiresAt: Date }
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
  // The route is public, so every call adds a row; drop the ones that can no longer be used.
  db.prepare("DELETE FROM login_challenges WHERE expires_at <= ?").run(
    issued.toISOString()
  )
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
  // The credential roster is authority: a key the protected checkpoint does not hold is not one.
  requireControlState(db)
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

type Verified = Extract<Checked, { ok: true }>

/**
 * In one transaction: consumes the challenge, advances the credential's counter (only if it is
 * still the one checked and the credential is not revoked) and runs `write`. False, with nothing
 * written, when anything moved since the check.
 */
function consumeChecked(
  db: DatabaseSync,
  checked: Verified,
  at: Date,
  write: () => void
): boolean {
  return atomically(db, () => {
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
    write()
    return true
  })
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

function storeSession(
  db: DatabaseSync,
  token: string,
  credentialId: string,
  at: Date,
  expiresAt: Date
): void {
  db.prepare(
    "INSERT INTO sessions (token_hash, credential_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(hex(token), credentialId, at.toISOString(), expiresAt.toISOString())
  auditLogin(db, "session.created", "created", credentialId)
}

/**
 * Starts a session for a credential that was just enrolled on the phone (#202), in the
 * caller's transaction. Returns the cookie value, which the gate never stores.
 */
export function startSession(
  db: DatabaseSync,
  credentialId: string,
  at: Date,
  keys?: WebSessionKeyPair
): { token: string; webSessionToken: string; expiresAt: Date } {
  const token = newNonce()
  const expiresAt = new Date(at.getTime() + SESSION_TTL_MS)
  storeSession(db, token, credentialId, at, expiresAt)
  const keyPair = keys ?? getOrCreateWebSessionKeys(db)
  const webSessionToken = signWebSession(
    {
      sub: credentialId,
      role: "owner",
      iat: Math.floor(at.getTime() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
    },
    keyPair.privateKey
  )
  return { token, webSessionToken, expiresAt }
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
  now: Clock,
  keys?: WebSessionKeyPair
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
  const created = consumeChecked(db, checked, at, () => {
    storeSession(db, token, checked.credentialId, at, expiresAt)
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
  const keyPair = keys ?? getOrCreateWebSessionKeys(db)
  const webSessionToken = signWebSession(
    {
      sub: checked.credentialId,
      role: "owner",
      iat: Math.floor(at.getTime() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
    },
    keyPair.privateKey
  )
  return { ok: true, token, webSessionToken, expiresAt }
}

/**
 * Invalidates a session by deleting it from `sessions` table and dropping any live elevation
 * from `elevations`. Appends a `session.logged_out` audit row with hashes only.
 */
export function logoutSession(
  db: DatabaseSync,
  elevations: Elevations,
  token: string
): boolean {
  const tokenHash = hex(token)
  elevations.delete(tokenHash)
  const deleted = db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .run(tokenHash)
  const removed = Number(deleted.changes) > 0
  if (removed) {
    append(db, {
      actor: "approver",
      action: "session.logged_out",
      target: "session",
      detailHash: payloadHash({ session_sha256: tokenHash }),
    })
  }
  return removed
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

type LiveSession = { credentialId: string; expiresAt: Date }

/**
 * The session behind `token`, or undefined when there is none: unknown, expired at `now`, or
 * its credential revoked.
 */
function liveSession(
  db: DatabaseSync,
  token: string | undefined,
  now: Clock
): LiveSession | undefined {
  if (token === undefined) return undefined
  const row = db
    .prepare(
      `SELECT s.expires_at, s.credential_id FROM sessions s
       JOIN credentials c ON c.credential_id = s.credential_id
       WHERE s.token_hash = ? AND c.revoked_at IS NULL`
    )
    .get(hex(token))
  if (row === undefined) return undefined
  const expiresAt = new Date(String(row["expires_at"]))
  if (expiresAt.getTime() <= now().getTime()) return undefined
  return { credentialId: String(row["credential_id"]), expiresAt }
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
  return liveSession(db, token, now)?.expiresAt
}

/** The credential id of the passkey that opened the live session behind `token`. */
export function sessionCredential(
  db: DatabaseSync,
  token: string | undefined,
  now: Clock
): string | undefined {
  return liveSession(db, token, now)?.credentialId
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

/** True when a passkey was enrolled and every one has since been revoked. */
export function onlyRevokedCredentials(db: DatabaseSync): boolean {
  return (
    !hasCredential(db) &&
    db.prepare("SELECT 1 FROM credentials LIMIT 1").get() !== undefined
  )
}

/** True when the gate holds at least one unrevoked passkey. */
export function hasCredential(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT 1 FROM credentials WHERE revoked_at IS NULL LIMIT 1")
      .get() !== undefined
  )
}

// Step-up (ADR 0009). A live session can be elevated for ELEVATION_TTL_MS by a fresh assertion
// from the passkey that opened it, over a single-use challenge from beginLogin. The elevation is
// held in memory only, keyed by the session token's hash, so a gate restart ends every one. It
// is never extended by use and never outlives its session; a new step-up replaces the old one.
// Routes that add authority still need their own signed assertion (ADR 0005): elevation never
// stands in for one.

/** How long a step-up lasts: 5 minutes, not renewed by use. */
export const ELEVATION_TTL_MS = 5 * 60 * 1000

/** The live elevations, keyed by the SHA-256 of the session token. */
export type Elevations = Map<string, { credentialId: string; until: Date }>

export type StepUpRefusal = LoginRefusal | "no_session" | "other_credential"

export type StepUpResult =
  { ok: true; until: Date } | { ok: false; reason: StepUpRefusal }

/**
 * Elevates the session behind `token`. The assertion must come from the session's own passkey;
 * the challenge is consumed and the counter advanced as for a login. Every outcome is audited
 * with hashes only.
 */
export function stepUp(
  db: DatabaseSync,
  config: WebAuthnConfig,
  elevations: Elevations,
  token: string | undefined,
  assertion: GateWebAuthnAssertion,
  now: Clock
): StepUpResult {
  const at = now()
  const refuse = (reason: StepUpRefusal): StepUpResult => {
    auditLogin(
      db,
      `session.step_up_refused.${reason}`,
      reason,
      assertion.credentialId
    )
    return { ok: false, reason }
  }
  const session = liveSession(db, token, now)
  if (token === undefined || session === undefined) return refuse("no_session")
  const checked = checkLogin(db, config, assertion, at)
  if (!checked.ok) return refuse(checked.reason)
  if (checked.credentialId !== session.credentialId) {
    return refuse("other_credential")
  }
  const until = new Date(
    Math.min(at.getTime() + ELEVATION_TTL_MS, session.expiresAt.getTime())
  )
  const done = consumeChecked(db, checked, at, () => {
    auditLogin(db, "session.stepped_up", "stepped_up", checked.credentialId)
  })
  if (!done) return refuse("lost_race")
  for (const [key, value] of elevations) {
    if (value.until.getTime() <= at.getTime()) elevations.delete(key)
  }
  elevations.set(hex(token), { credentialId: checked.credentialId, until })
  return { ok: true, until }
}

/**
 * When the elevation of the session behind `token` ends, or undefined when it is not elevated:
 * no live session, no step-up, the step-up expired, or the session's passkey changed.
 */
export function elevatedUntil(
  db: DatabaseSync,
  elevations: Elevations,
  token: string | undefined,
  now: Clock
): Date | undefined {
  const session = liveSession(db, token, now)
  if (token === undefined || session === undefined) return undefined
  const elevation = elevations.get(hex(token))
  if (elevation === undefined) return undefined
  if (elevation.credentialId !== session.credentialId) return undefined
  if (elevation.until.getTime() <= now().getTime()) return undefined
  return elevation.until
}

/**
 * Lets one request on an elevated route use the session's elevation, auditing the use with the
 * route and hashes only. False, with nothing written, when the session is not elevated.
 */
export function useElevation(
  db: DatabaseSync,
  elevations: Elevations,
  token: string | undefined,
  route: string,
  now: Clock
): boolean {
  if (token === undefined) return false
  const until = elevatedUntil(db, elevations, token, now)
  if (until === undefined) return false
  append(db, {
    actor: "approver",
    action: "session.elevation_used",
    target: route,
    detailHash: payloadHash({ session_sha256: hex(token) }),
  })
  return true
}
