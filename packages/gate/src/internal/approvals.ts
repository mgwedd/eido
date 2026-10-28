import type { DatabaseSync } from "node:sqlite"
import type { GateDecisionRequest, GateRejectReason } from "@eido/schemas"
import { append } from "./audit"
import { hashCanonicalString, payloadHash } from "./canonical"
import { decidePending } from "./intents"
import { issueCurrentNonce } from "./nonces"
import { atomically } from "./transaction"
import {
  approvalChallenge,
  checkCeremony,
  fromBase64url,
  parseAuthenticatorData,
  parseClientData,
  sha256,
  verifyAssertionSignature,
} from "./webauthn"
import type { CeremonyFailure, WebAuthnConfig } from "./webauthn"

// The approval verifier (#15): the one door from pending to approved. The device signs a WebAuthn
// assertion over a challenge built from the payload hash, the intent id and the intent's current
// nonce; the gate recomputes the hash from the stored canonical payload, rebuilds the challenge
// and checks the assertion, then decides the intent in one transaction whose conditional updates
// let only one of two concurrent verifiers win. Audit rows carry ids and hashes only: never a
// signature, a nonce or a payload body.

export type ApprovalAssertion = Extract<
  GateDecisionRequest,
  { decision: "approved" }
>["assertion"]

export type ApprovalRequest = {
  intentId: string
  /** The nonce the assertion was signed over, as returned by issueNonce. */
  nonce: string
  assertion: ApprovalAssertion
}

/** Why an approval was refused. Recorded in the audit action; the caller only sees a generic error. */
export type RefusalReason =
  | CeremonyFailure
  | "unknown_intent"
  | "unknown_nonce"
  | "foreign_nonce"
  | "nonce_used"
  | "not_pending"
  | "stale_nonce"
  | "malformed"
  | "unknown_credential"
  | "revoked_credential"
  | "bad_signature"
  | "sign_count"
  | "approval_mismatch"
  | "lost_race"

export type ApprovalResult =
  | { ok: true; intentId: string; state: "approved"; nudge: boolean }
  | { ok: false; error: "approval_refused" }

export type PreparedApproval =
  | {
      ok: true
      intentId: string
      /** The stored canonical payload, RFC 8785 JSON text. */
      payload: string
      /** SHA-256 of `payload`, recomputed now. */
      payloadHash: string
      nonce: string
    }
  | { ok: false; code: "not_found" | "not_pending" }

export type RejectResult =
  | { ok: true; intentId: string; state: "rejected" }
  | { ok: false; code: "not_found" | "not_pending" }

type IntentRow = {
  id: string
  state: string
  payloadJson: string
  payloadHash: string
  currentNonce: string | null
}

function intentRow(db: DatabaseSync, id: string): IntentRow | undefined {
  const row = db
    .prepare(
      "SELECT id, state, payload_json, payload_hash, current_nonce FROM intents WHERE id = ?"
    )
    .get(id)
  if (row === undefined) return undefined
  const current = row["current_nonce"]
  return {
    id: String(row["id"]),
    state: String(row["state"]),
    payloadJson: String(row["payload_json"]),
    payloadHash: String(row["payload_hash"]),
    currentNonce: typeof current === "string" ? current : null,
  }
}

/**
 * Prepares (or re-prepares) the approval card: issues a fresh nonce for a pending intent and
 * supersedes the previous one. Returns the nonce with the stored canonical payload and its hash.
 */
export function issueNonce(
  db: DatabaseSync,
  intentId: string
): PreparedApproval {
  return atomically(db, () => {
    const intent = intentRow(db, intentId)
    if (intent === undefined) return { ok: false, code: "not_found" }
    if (intent.state !== "pending") return { ok: false, code: "not_pending" }
    return {
      ok: true,
      intentId,
      payload: intent.payloadJson,
      payloadHash: hashCanonicalString(intent.payloadJson),
      nonce: issueCurrentNonce(db, intentId),
    }
  })
}

export type DecodedAssertion = {
  credentialId: string
  authenticatorData: Buffer
  clientDataJSON: Buffer
  signature: Buffer
}

/** Decodes the four base64url fields of an assertion; undefined when any is not base64url. */
export function decodeAssertion(
  assertion: ApprovalAssertion
): DecodedAssertion | undefined {
  const authenticatorData = fromBase64url(assertion.authenticatorData)
  const clientDataJSON = fromBase64url(assertion.clientDataJSON)
  const signature = fromBase64url(assertion.signature)
  if (
    fromBase64url(assertion.credentialId) === undefined ||
    authenticatorData === undefined ||
    clientDataJSON === undefined ||
    signature === undefined
  ) {
    return undefined
  }
  return {
    credentialId: assertion.credentialId,
    authenticatorData,
    clientDataJSON,
    signature,
  }
}

/** What a passing check hands to the commit. */
export type VerifiedApproval = {
  intentId: string
  nonce: string
  payloadHash: string
  credentialId: string
  storedSignCount: number
  signCount: number
  signature: string
}

export type CheckResult =
  | { ok: true; approval: VerifiedApproval }
  | { ok: false; reason: RefusalReason }

/** Accepts a counter that grows, or a counter that stays at zero (authenticators that do not count, such as synced passkeys). */
export function signCountAccepted(stored: number, received: number): boolean {
  return received > stored || (stored === 0 && received === 0)
}

/**
 * Every check of an approval, read-only. The nonce must be the intent's current, unused nonce
 * and the intent pending; the assertion must pass the ceremony checks, verify against an
 * enrolled, unrevoked credential and carry a valid sign count; and its challenge must equal the
 * one rebuilt from the hash of the stored payload. A failing challenge is `approval_mismatch`.
 */
export function checkApproval(
  db: DatabaseSync,
  config: WebAuthnConfig,
  request: ApprovalRequest
): CheckResult {
  const refuse = (reason: RefusalReason): CheckResult => ({
    ok: false,
    reason,
  })
  const intent = intentRow(db, request.intentId)
  if (intent === undefined) return refuse("unknown_intent")
  const nonce = db
    .prepare("SELECT intent_id, used_at FROM approval_nonces WHERE nonce = ?")
    .get(request.nonce)
  if (nonce === undefined) return refuse("unknown_nonce")
  if (nonce["intent_id"] !== intent.id) return refuse("foreign_nonce")
  if (nonce["used_at"] !== null) return refuse("nonce_used")
  if (intent.state !== "pending") return refuse("not_pending")
  if (intent.currentNonce !== request.nonce) return refuse("stale_nonce")

  const decoded = decodeAssertion(request.assertion)
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
  // Never trust the stored hash alone: recompute it from the stored bytes.
  const hash = hashCanonicalString(intent.payloadJson)
  const expected = approvalChallenge(hash, intent.id, request.nonce)
  if (
    hash !== intent.payloadHash ||
    clientData.challenge !== expected.toString("base64url")
  ) {
    return refuse("approval_mismatch")
  }
  return {
    ok: true,
    approval: {
      intentId: intent.id,
      nonce: request.nonce,
      payloadHash: hash,
      credentialId: decoded.credentialId,
      storedSignCount,
      signCount: authData.signCount,
      signature: request.assertion.signature,
    },
  }
}

const LOST = new Error("approval lost the race")

/**
 * Decides a checked approval in one transaction: the intent moves pending to approved only if it
 * still holds the signed nonce, the credential's counter is advanced only if it is still the one
 * checked and the credential is not revoked, the nonce is marked used and the approval row is
 * written. If anything moved since the check, nothing is written and the result is false.
 */
export function commitApproval(
  db: DatabaseSync,
  approval: VerifiedApproval,
  now: Date = new Date()
): boolean {
  try {
    return atomically(db, () => {
      const decidedAt = now.toISOString()
      const decided = decidePending(
        db,
        approval.intentId,
        "approved",
        "approver",
        { nonce: approval.nonce }
      )
      if (decided === undefined) throw LOST
      const { changes } = db
        .prepare(
          "UPDATE credentials SET sign_count = ? WHERE credential_id = ? AND sign_count = ? AND revoked_at IS NULL"
        )
        .run(
          approval.signCount,
          approval.credentialId,
          approval.storedSignCount
        )
      if (Number(changes) !== 1) throw LOST
      db.prepare("UPDATE approval_nonces SET used_at = ? WHERE nonce = ?").run(
        decidedAt,
        approval.nonce
      )
      db.prepare(
        `INSERT INTO approvals (intent_id, bundle_hash, decision, signature, credential_id, sign_count, nonce, decided_at, reason_code)
         VALUES (?, ?, 'approved', ?, ?, ?, ?, ?, NULL)`
      ).run(
        approval.intentId,
        approval.payloadHash,
        approval.signature,
        approval.credentialId,
        approval.signCount,
        approval.nonce,
        decidedAt
      )
      return true
    })
  } catch (error) {
    if (error === LOST) return false
    throw error
  }
}

const hex = (value: string) => sha256(value).toString("hex")

function auditRefusal(
  db: DatabaseSync,
  request: ApprovalRequest,
  reason: RefusalReason
): void {
  append(db, {
    actor: "approver",
    action:
      reason === "approval_mismatch"
        ? "alert.approval_mismatch"
        : `approval.refused.${reason}`,
    target: request.intentId,
    detailHash: payloadHash({
      reason,
      intent_id: request.intentId,
      nonce_sha256: hex(request.nonce),
      credential_sha256: hex(request.assertion.credentialId),
    }),
  })
}

function insertRejection(
  db: DatabaseSync,
  intentId: string,
  bundleHash: string,
  reasonCode: string | null
): void {
  db.prepare(
    `INSERT INTO approvals (intent_id, bundle_hash, decision, signature, credential_id, sign_count, nonce, decided_at, reason_code)
     VALUES (?, ?, 'rejected', NULL, NULL, NULL, NULL, ?, ?)`
  ).run(intentId, bundleHash, new Date().toISOString(), reasonCode)
}

/**
 * Verifies an approval and, when it passes, decides the intent (see commitApproval). A
 * challenge or payload mismatch rejects the intent and appends an `alert.approval_mismatch`
 * row; every other refusal leaves the intent as it was. Each outcome is audited, and the
 * caller only ever learns that the approval was refused.
 */
export function verifyApproval(
  db: DatabaseSync,
  config: WebAuthnConfig,
  request: ApprovalRequest,
  options: { now?: () => Date; threshold?: number; windowMs?: number } = {}
): ApprovalResult {
  const checked = checkApproval(db, config, request)
  let reason: RefusalReason
  if (checked.ok) {
    const now = (options.now ?? (() => new Date()))()
    const threshold = options.threshold ?? 5
    const windowMs = options.windowMs ?? 120_000
    if (
      !Number.isSafeInteger(threshold) ||
      threshold < 0 ||
      !Number.isSafeInteger(windowMs) ||
      windowMs < 1
    )
      throw new Error("invalid approval nudge settings")
    if (commitApproval(db, checked.approval, now)) {
      const recent = db
        .prepare(
          "SELECT count(*) AS count FROM approvals WHERE decision = 'approved' AND decided_at >= ? AND decided_at <= ?"
        )
        .get(
          new Date(now.getTime() - windowMs).toISOString(),
          now.toISOString()
        )
      return {
        ok: true,
        intentId: request.intentId,
        state: "approved",
        nudge: Number(recent?.["count"] ?? 0) > threshold,
      }
    }
    reason = "lost_race"
  } else {
    reason = checked.reason
  }
  atomically(db, () => {
    const rejected =
      reason === "approval_mismatch"
        ? decidePending(db, request.intentId, "rejected", "system", {
            reason: "approval_mismatch",
          })
        : undefined
    if (rejected !== undefined) {
      insertRejection(db, request.intentId, rejected, "approval_mismatch")
    }
    auditRefusal(db, request, reason)
  })
  return { ok: false, error: "approval_refused" }
}

/** The owner's reject of a pending intent, with an optional reason code for the eval set. */
export function reject(
  db: DatabaseSync,
  intentId: string,
  reasonCode?: GateRejectReason
): RejectResult {
  return atomically(db, () => {
    const decided = decidePending(
      db,
      intentId,
      "rejected",
      "approver",
      reasonCode === undefined ? {} : { reason: reasonCode }
    )
    if (decided === undefined) {
      const code =
        intentRow(db, intentId) === undefined ? "not_found" : "not_pending"
      append(db, {
        actor: "approver",
        action: `approval.reject_refused.${code}`,
        target: intentId,
        detailHash: payloadHash({ reason: code, intent_id: intentId }),
      })
      return { ok: false, code }
    }
    insertRejection(db, intentId, decided, reasonCode ?? null)
    return { ok: true, intentId, state: "rejected" }
  })
}
