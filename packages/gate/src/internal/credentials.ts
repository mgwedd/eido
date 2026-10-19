import type { DatabaseSync } from "node:sqlite"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import { newNonce } from "./nonces"
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

// Passkey enrolment and revocation. Both are admin actions: the gate accepts them only from its
// Mac-side admin surface (the localhost route #78 serves), never from the phone-facing API, so
// a stolen phone session cannot enrol a key or revoke the owner's. Enrolment uses attestation
// "none": the browser's registration response (clientDataJSON, authenticatorData, and the
// public key as SubjectPublicKeyInfo from getPublicKey()) is checked for the issued challenge,
// the origin and RP id, user presence and verification, and the attested credential id.
// Every call, accepted or refused, is audited with hashes only.

/** Which listener a request arrived on: the Mac-side admin route, or the phone-facing API. */
export type Surface = "admin" | "phone"

export type Registration = {
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  /** AuthenticatorAttestationResponse.getPublicKey(): SubjectPublicKeyInfo DER, base64url. */
  publicKey: string
  /** AuthenticatorAttestationResponse.getPublicKeyAlgorithm(): a COSE algorithm id. */
  publicKeyAlgorithm: number
}

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
  const challenge = newNonce()
  db.prepare(
    "INSERT INTO registration_challenges (challenge, issued_at, used_at) VALUES (?, ?, NULL)"
  ).run(challenge, new Date().toISOString())
  return { ok: true, challenge }
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
    const exists = db
      .prepare("SELECT 1 FROM credentials WHERE credential_id = ?")
      .get(registration.credentialId)
    if (exists !== undefined) return refuse("credential_exists")
    const now = new Date().toISOString()
    const used = db
      .prepare(
        "UPDATE registration_challenges SET used_at = ? WHERE challenge = ? AND used_at IS NULL"
      )
      .run(now, accepted.challenge)
    if (Number(used.changes) !== 1) return refuse("unknown_challenge")
    db.prepare(
      "INSERT INTO credentials (credential_id, public_key, sign_count, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)"
    ).run(
      registration.credentialId,
      accepted.publicKey.toString("base64url"),
      accepted.signCount,
      now
    )
    audit(
      db,
      surface,
      "credential.registered",
      registration.credentialId,
      "registered"
    )
    return { ok: true, credentialId: registration.credentialId }
  })
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
