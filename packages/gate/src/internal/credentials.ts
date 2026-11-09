import type { DatabaseSync } from "node:sqlite"
import type { GatePasskeyList, GateWebAuthnRegistration } from "@eido/schemas"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import { consumeEnrolmentCode } from "./enrolment"
import type { ConsumeRefusal } from "./enrolment"
import { newNonce } from "./nonces"
import { startSession } from "./sessions"
import type { Clock, WebSessionKeyPair } from "./sessions"
import type { Surface } from "./surface"
import { atomically } from "./transaction"
import {
  ES256,
  checkCeremony,
  fromBase64url,
  isP256PublicKey,
  parseAuthenticatorData,
  parseClientData,
  sha256,
} from "./webauthn"
import type { CeremonyFailure, WebAuthnConfig } from "./webauthn"

// Passkey enrolment and revocation. Revocation is an admin action: the gate accepts it only from
// its Mac-side admin surface (the control socket #78 serves), never from the phone-facing API, so
// a stolen phone session cannot revoke the owner's key. Enrolment happens on the admin surface,
// or on the phone with a single-use code the owner issued on the Mac (#202): no session can
// enrol a key without that code. Enrolment uses attestation
// "none": the browser's registration response (clientDataJSON, authenticatorData, and the
// public key as SubjectPublicKeyInfo from getPublicKey()) is checked for the issued challenge,
// the origin and RP id, user presence and verification, and the attested credential id.
// Every call, accepted or refused, is audited with hashes only.

export type { Surface } from "./surface"

/**
 * The browser's registration response: the public key is getPublicKey() (SubjectPublicKeyInfo
 * DER, base64url) and the algorithm getPublicKeyAlgorithm() (a COSE id).
 */
export type Registration = GateWebAuthnRegistration

export type RegistrationRefusal =
  | CeremonyFailure
  | "admin_only"
  | "malformed"
  | "unknown_challenge"
  | "not_attested"
  | "credential_mismatch"
  | "unsupported_algorithm"
  | "credential_exists"

export type BeginRegistrationResult =
  { ok: true; challenge: string } | { ok: false; code: "admin_only" }

export type RegisterResult =
  { ok: true; credentialId: string } | { ok: false; code: RegistrationRefusal }

export type EnrolResult =
  | {
      ok: true
      credentialId: string
      token: string
      webSessionToken: string
      expiresAt: Date
    }
  | { ok: false; code: RegistrationRefusal | ConsumeRefusal }

export type RevokeResult =
  | { ok: true }
  | { ok: false; code: "admin_only" | "unknown_credential" | "already_revoked" }

const hex = (value: string) => sha256(value).toString("hex")

function audit(
  db: DatabaseSync,
  surface: Surface,
  action: string,
  credentialId: string,
  outcome: string
): void {
  append(db, {
    actor: surface === "admin" ? "owner" : "approver",
    action,
    target: "credential",
    detailHash: payloadHash({
      outcome,
      credential_sha256: hex(credentialId),
    }),
  })
}

/** Issues a single-use enrolment challenge (32 random bytes, base64url). Admin surface only. */
export function beginRegistration(
  db: DatabaseSync,
  surface: Surface
): BeginRegistrationResult {
  if (surface !== "admin") {
    audit(db, surface, "credential.register_refused", "", "admin_only")
    return { ok: false, code: "admin_only" }
  }
  return { ok: true, challenge: issueChallenge(db, new Date()) }
}

function issueChallenge(db: DatabaseSync, at: Date): string {
  const challenge = newNonce()
  db.prepare(
    "INSERT INTO registration_challenges (challenge, issued_at, used_at) VALUES (?, ?, NULL)"
  ).run(challenge, at.toISOString())
  return challenge
}

/**
 * Issues a registration challenge for the phone's enrol options route, which has already
 * checked the enrolment code. The code is consumed only when the enrolment itself succeeds.
 */
export function beginPhoneRegistration(db: DatabaseSync, now: Clock): string {
  return issueChallenge(db, now())
}

type Accepted = {
  publicKey: Buffer
  signCount: number
  challenge: string
}

function checkRegistration(
  db: DatabaseSync,
  config: WebAuthnConfig,
  registration: Registration
): { ok: true; accepted: Accepted } | { ok: false; code: RegistrationRefusal } {
  const credentialId = fromBase64url(registration.credentialId)
  const clientDataBytes = fromBase64url(registration.clientDataJSON)
  const authDataBytes = fromBase64url(registration.authenticatorData)
  const publicKey = fromBase64url(registration.publicKey)
  const clientData =
    clientDataBytes === undefined ? undefined : parseClientData(clientDataBytes)
  const authData =
    authDataBytes === undefined
      ? undefined
      : parseAuthenticatorData(authDataBytes)
  if (
    credentialId === undefined ||
    publicKey === undefined ||
    clientData === undefined ||
    authData === undefined
  ) {
    return { ok: false, code: "malformed" }
  }
  const challenge = db
    .prepare("SELECT used_at FROM registration_challenges WHERE challenge = ?")
    .get(clientData.challenge)
  if (challenge === undefined || challenge["used_at"] !== null) {
    return { ok: false, code: "unknown_challenge" }
  }
  const ceremony = checkCeremony(
    config,
    "webauthn.create",
    clientData,
    authData
  )
  if (ceremony !== undefined) return { ok: false, code: ceremony }
  if (authData.attestedCredentialId === undefined) {
    return { ok: false, code: "not_attested" }
  }
  if (!authData.attestedCredentialId.equals(credentialId)) {
    return { ok: false, code: "credential_mismatch" }
  }
  if (
    registration.publicKeyAlgorithm !== ES256 ||
    !isP256PublicKey(publicKey)
  ) {
    return { ok: false, code: "unsupported_algorithm" }
  }
  return {
    ok: true,
    accepted: {
      publicKey,
      signCount: authData.signCount,
      challenge: clientData.challenge,
    },
  }
}

/**
 * Enrols a passkey from a verified registration response. Admin surface only. The challenge is
 * consumed in the same transaction that stores the credential. A credential id that was ever
 * enrolled, including a revoked one, cannot be enrolled again.
 */
export function registerCredential(
  db: DatabaseSync,
  config: WebAuthnConfig,
  surface: Surface,
  registration: Registration
): RegisterResult {
  const refuse = (code: RegistrationRefusal): RegisterResult => {
    audit(
      db,
      surface,
      "credential.register_refused",
      registration.credentialId,
      code
    )
    return { ok: false, code }
  }
  if (surface !== "admin") return refuse("admin_only")
  const checked = checkRegistration(db, config, registration)
  if (!checked.ok) return refuse(checked.code)
  const { accepted } = checked
  return atomically(db, () => {
    const at = new Date()
    const claimed = claimChallenge(db, registration, accepted, at)
    if (claimed !== undefined) return refuse(claimed)
    return storeCredential(db, surface, registration, accepted, at)
  })
}

/**
 * In the caller's transaction: refuses a credential id that was ever enrolled, revoked ones
 * included, and consumes the challenge. Undefined when the enrolment may go ahead.
 */
function claimChallenge(
  db: DatabaseSync,
  registration: Registration,
  accepted: Accepted,
  at: Date
): RegistrationRefusal | undefined {
  const exists = db
    .prepare("SELECT 1 FROM credentials WHERE credential_id = ?")
    .get(registration.credentialId)
  if (exists !== undefined) return "credential_exists"
  const used = db
    .prepare(
      "UPDATE registration_challenges SET used_at = ? WHERE challenge = ? AND used_at IS NULL"
    )
    .run(at.toISOString(), accepted.challenge)
  return Number(used.changes) === 1 ? undefined : "unknown_challenge"
}

function storeCredential(
  db: DatabaseSync,
  surface: Surface,
  registration: Registration,
  accepted: Accepted,
  at: Date
): { ok: true; credentialId: string } {
  db.prepare(
    "INSERT INTO credentials (credential_id, public_key, sign_count, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)"
  ).run(
    registration.credentialId,
    accepted.publicKey.toString("base64url"),
    accepted.signCount,
    at.toISOString()
  )
  audit(
    db,
    surface,
    "credential.registered",
    registration.credentialId,
    "registered"
  )
  return { ok: true, credentialId: registration.credentialId }
}

/**
 * Enrols a passkey from the phone with a Mac-issued enrolment code (#202), and signs the phone
 * in. In one transaction: the challenge and the code are consumed, the credential is stored and
 * a session starts. A registration that fails its checks leaves the code unused; a refused code
 * is audited by the code check and stores nothing. Earlier credentials, revoked ones included,
 * are untouched.
 */
export function enrolWithCode(
  db: DatabaseSync,
  config: WebAuthnConfig,
  code: string,
  registration: Registration,
  now: Clock,
  keys?: WebSessionKeyPair
): EnrolResult {
  const refuse = (refusal: RegistrationRefusal): EnrolResult => {
    audit(
      db,
      "phone",
      "credential.register_refused",
      registration.credentialId,
      refusal
    )
    return { ok: false, code: refusal }
  }
  const checked = checkRegistration(db, config, registration)
  if (!checked.ok) return refuse(checked.code)
  const { accepted } = checked
  const at = now()
  return atomically(db, (): EnrolResult => {
    const claimed = claimChallenge(db, registration, accepted, at)
    if (claimed !== undefined) return refuse(claimed)
    const consumed = consumeEnrolmentCode(db, "phone", code, () => at)
    if (!consumed.ok) return consumed
    storeCredential(db, "phone", registration, accepted, at)
    const session = startSession(db, registration.credentialId, at, keys)
    return { ok: true, credentialId: registration.credentialId, ...session }
  })
}

/**
 * Every enrolled passkey, revoked ones included. Credential ids are given as SHA-256
 * fingerprints; public keys and sign counters stay inside the gate. `current` marks the
 * passkey with id `currentCredentialId`: the one that opened the caller's session (#420).
 */
export function listPasskeys(
  db: DatabaseSync,
  currentCredentialId?: string
): GatePasskeyList["passkeys"] {
  return db
    .prepare(
      "SELECT credential_id, created_at, revoked_at FROM credentials ORDER BY created_at, credential_id"
    )
    .all()
    .map((row) => {
      const credentialId = String(row["credential_id"])
      return {
        fingerprint: hex(credentialId),
        createdAt: String(row["created_at"]),
        revokedAt:
          typeof row["revoked_at"] === "string" ? row["revoked_at"] : null,
        current: credentialId === currentCredentialId,
      }
    })
}

/**
 * Revokes the passkey whose credential id has this SHA-256 fingerprint (#419), the form the
 * owner sees in Settings and in `pnpm --filter @eido/gate passkeys`. Admin surface only.
 */
export function revokeByFingerprint(
  db: DatabaseSync,
  surface: Surface,
  fingerprint: string
): RevokeResult {
  // Without a credential id to hash, a refusal's audit row hashes the fingerprint given instead.
  const refuse = (code: "admin_only" | "unknown_credential"): RevokeResult => {
    audit(db, surface, "credential.revoke_refused", fingerprint, code)
    return { ok: false, code }
  }
  // The surface is checked first, so a phone cannot probe which fingerprints exist.
  if (surface !== "admin") return refuse("admin_only")
  const match = db
    .prepare("SELECT credential_id FROM credentials")
    .all()
    .map((row) => String(row["credential_id"]))
    .find((id) => hex(id) === fingerprint)
  if (match === undefined) return refuse("unknown_credential")
  return revokeCredential(db, surface, match)
}

/** Revokes a passkey, so no later assertion from it verifies. Admin surface only. */
export function revokeCredential(
  db: DatabaseSync,
  surface: Surface,
  credentialId: string
): RevokeResult {
  return atomically(db, () => {
    const refuse = (
      code: Extract<RevokeResult, { ok: false }>["code"]
    ): RevokeResult => {
      audit(db, surface, "credential.revoke_refused", credentialId, code)
      return { ok: false, code }
    }
    if (surface !== "admin") return refuse("admin_only")
    const row = db
      .prepare("SELECT revoked_at FROM credentials WHERE credential_id = ?")
      .get(credentialId)
    if (row === undefined) return refuse("unknown_credential")
    if (row["revoked_at"] !== null) return refuse("already_revoked")
    db.prepare(
      "UPDATE credentials SET revoked_at = ? WHERE credential_id = ?"
    ).run(new Date().toISOString(), credentialId)
    audit(db, surface, "credential.revoked", credentialId, "revoked")
    return { ok: true }
  })
}
