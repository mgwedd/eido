import { randomBytes, randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { GateDecisionRequest } from "@eido/schemas"
import { verifyChain } from "./audit"
import { canonicalize, payloadHash } from "./canonical"
import {
  approvalRefHash,
  controlChallenge,
  hexDigest,
} from "./control-ceremony"
import {
  captureControlAssertion,
  controlTransaction,
} from "./control-checkpoint"
import {
  checkCeremony,
  fromBase64url,
  parseAuthenticatorData,
  parseClientData,
  verifyAssertionSignature,
} from "./webauthn"
import type { WebAuthnConfig } from "./webauthn"

export type ControlPurpose = "manifest.pin" | "policy.set"
type ApprovalAssertion = Extract<
  GateDecisionRequest,
  { decision: "approved"; nonce: string }
>["assertion"]
export type PreparedControlApproval = {
  id: string
  purpose: ControlPurpose
  target: string
  payload: string
  payloadHash: string
  nonce: string
}
export type ControlApprovalRequest = {
  id: string
  nonce: string
  assertion: ApprovalAssertion
}
export type ControlAuthorization = { config: WebAuthnConfig; request: unknown }

/** Browser challenge for an already prepared signed control change. */
export function controlApprovalChallenge(
  prepared: PreparedControlApproval
): string {
  return controlChallenge(
    prepared.purpose,
    prepared.target,
    prepared.id,
    prepared.payloadHash,
    prepared.nonce
  )
}

/** Prepares a fresh control ceremony; replacing it invalidates any earlier card for this target. */
export function prepareControlApproval(
  db: DatabaseSync,
  purpose: ControlPurpose,
  target: string,
  payload: unknown
): PreparedControlApproval {
  return controlTransaction(db, "signed", () => {
    const id = randomUUID()
    const nonce = randomBytes(32).toString("base64url")
    const hash = payloadHash(payload)
    const now = new Date().toISOString()
    db.prepare(
      "UPDATE control_approvals SET superseded_at = ? WHERE purpose = ? AND target = ? AND used_at IS NULL AND superseded_at IS NULL"
    ).run(now, purpose, target)
    db.prepare(
      "INSERT INTO control_approvals (id, purpose, target, payload_hash, nonce, issued_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, purpose, target, hash, nonce, now)
    return {
      id,
      purpose,
      target,
      payload: canonicalize(payload),
      payloadHash: hash,
      nonce,
    }
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function request(value: unknown): ControlApprovalRequest | undefined {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.nonce !== "string" ||
    !record(value.assertion)
  )
    return undefined
  const { credentialId, authenticatorData, clientDataJSON, signature } =
    value.assertion
  if (
    typeof credentialId !== "string" ||
    typeof authenticatorData !== "string" ||
    typeof clientDataJSON !== "string" ||
    typeof signature !== "string"
  )
    return undefined
  return {
    id: value.id,
    nonce: value.nonce,
    assertion: { credentialId, authenticatorData, clientDataJSON, signature },
  }
}

const refused = (): never => {
  throw new Error("control approval refused")
}

/** Verifies at the mutation boundary; no caller-supplied "verified" object can authorize a write. */
export function withControlApproval<T>(
  db: DatabaseSync,
  purpose: ControlPurpose,
  target: string,
  hash: string,
  authorization: ControlAuthorization | undefined,
  mutate: (
    approvalRefHash: string,
    approvalId: string
  ) => { result: T; auditSeq: number }
): T {
  return controlTransaction(db, "signed", () => {
    const signed = request(authorization?.request)
    if (authorization === undefined || signed === undefined) return refused()
    const row = db
      .prepare("SELECT * FROM control_approvals WHERE id = ?")
      .get(signed.id)
    if (
      row === undefined ||
      row["purpose"] !== purpose ||
      row["target"] !== target ||
      row["payload_hash"] !== hash ||
      row["nonce"] !== signed.nonce ||
      row["used_at"] !== null ||
      row["superseded_at"] !== null
    )
      return refused()
    const assertion = signed.assertion
    const authBytes = fromBase64url(assertion.authenticatorData)
    const clientBytes = fromBase64url(assertion.clientDataJSON)
    const signature = fromBase64url(assertion.signature)
    const auth =
      authBytes === undefined ? undefined : parseAuthenticatorData(authBytes)
    const client =
      clientBytes === undefined ? undefined : parseClientData(clientBytes)
    if (
      authBytes === undefined ||
      clientBytes === undefined ||
      signature === undefined ||
      auth === undefined ||
      client === undefined ||
      fromBase64url(assertion.credentialId) === undefined
    )
      return refused()
    const credential = db
      .prepare(
        "SELECT public_key, sign_count, revoked_at FROM credentials WHERE credential_id = ?"
      )
      .get(assertion.credentialId)
    if (
      credential === undefined ||
      credential["revoked_at"] !== null ||
      checkCeremony(authorization.config, "webauthn.get", client, auth) !==
        undefined
    )
      return refused()
    const storedCount = Number(credential["sign_count"])
    if (
      !(
        auth.signCount > storedCount ||
        (storedCount === 0 && auth.signCount === 0)
      ) ||
      client.challenge !==
        controlChallenge(purpose, target, signed.id, hash, signed.nonce) ||
      !verifyAssertionSignature(
        Buffer.from(String(credential["public_key"]), "base64url"),
        authBytes,
        clientBytes,
        signature
      )
    )
      return refused()
    const credentialHash = hexDigest(assertion.credentialId)
    const signatureHash = hexDigest(assertion.signature)
    const approvalRef = approvalRefHash({
      id: signed.id,
      purpose,
      target,
      payloadHash: hash,
      credentialHash,
      signatureHash,
      signCount: auth.signCount,
      nonce: signed.nonce,
    })
    const changed = db
      .prepare(
        "UPDATE credentials SET sign_count = ? WHERE credential_id = ? AND sign_count = ? AND revoked_at IS NULL"
      )
      .run(auth.signCount, assertion.credentialId, storedCount)
    if (Number(changed.changes) !== 1) return refused()
    const outcome = mutate(approvalRef, signed.id)
    const consumed = db
      .prepare(
        "UPDATE control_approvals SET used_at = ?, approval_ref_hash = ?, credential_hash = ?, signature_hash = ?, sign_count = ?, audit_seq = ? WHERE id = ? AND used_at IS NULL AND superseded_at IS NULL"
      )
      .run(
        new Date().toISOString(),
        approvalRef,
        credentialHash,
        signatureHash,
        auth.signCount,
        outcome.auditSeq,
        signed.id
      )
    if (Number(consumed.changes) !== 1) return refused()
    captureControlAssertion(db, {
      approvalId: signed.id,
      purpose,
      target,
      payloadHash: hash,
      nonce: signed.nonce,
      approvalRefHash: approvalRef,
      credentialId: assertion.credentialId,
      signCount: auth.signCount,
      auditSeq: outcome.auditSeq,
      assertion: {
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
        signature: assertion.signature,
      },
    })
    return outcome.result
  })
}

/** Checks the immutable signed provenance and audit binding of a persisted control value. */
export function approvedControlValue(
  db: DatabaseSync,
  id: string,
  purpose: ControlPurpose,
  target: string,
  hash: string,
  action: string,
  detail: (approvalRefHash: string) => string
): boolean {
  const row = db.prepare("SELECT * FROM control_approvals WHERE id = ?").get(id)
  if (
    row === undefined ||
    row["used_at"] === null ||
    row["superseded_at"] !== null ||
    row["purpose"] !== purpose ||
    row["target"] !== target ||
    row["payload_hash"] !== hash
  )
    return false
  const ref = approvalRefHash({
    id,
    purpose,
    target,
    payloadHash: hash,
    credentialHash: String(row["credential_hash"]),
    signatureHash: String(row["signature_hash"]),
    signCount: Number(row["sign_count"]),
    nonce: String(row["nonce"]),
  })
  if (ref !== row["approval_ref_hash"]) return false
  const audit = db
    .prepare("SELECT action, target, detail_hash FROM audit_log WHERE seq = ?")
    .get(row["audit_seq"] ?? null)
  return (
    audit?.["action"] === action &&
    audit["target"] === target &&
    audit["detail_hash"] === detail(ref) &&
    verifyChain(db).ok
  )
}
