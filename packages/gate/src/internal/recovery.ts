import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { GateRecoveryWindow } from "@eido/schemas"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import {
  controlApprovalChallenge,
  prepareControlApproval,
  withControlApproval,
} from "./control-approvals"
import type { ControlAuthorization } from "./control-approvals"
import type { Clock } from "./sessions"
import { atomically } from "./transaction"

// Owner recovery keys. The owner holds one single-use key, shown once at the first enrolment, for
// the day every passkey is lost. It is 160 random bits as 32 Crockford base32 characters (an
// enrolment code is 16), stored only as a salted scrypt digest under a random key id. Using it
// does not enrol anything: it starts a 24-hour delay, a push alert goes to every verified
// subscription, and any unrevoked passkey can cancel the recovery with a signed assertion. After
// the delay, and before the post-maturity window ends, the key enrols one new passkey, starts a
// session and is replaced. Every step and refusal is audited with hashes only: never the key and
// never a hash of a rejected guess.

/** How long after a start the recovery stays blocked, so an alert can reach the owner. */
export const RECOVERY_DELAY_MS = 24 * 60 * 60 * 1000
/** How long after maturity the recovery can still be completed. */
export const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000

/** The signed control change that cancels a pending recovery. */
export const RECOVERY_KEY_TARGET = "recovery_key"

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const KEY_BYTES = 20
const KEY_LENGTH = 32
const GROUP = 4
const MAX_INPUT_LENGTH = 64
const SALT_BYTES = 16
const DIGEST_BYTES = 32
// N = 2^15, r = 8 needs 32 MiB, which is Node's default maxmem exactly, and scrypt wants more.
const SCRYPT = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const

export type RecoveryRefusal =
  | "malformed"
  | "invalid_key"
  | "already_pending"
  | "no_recovery"
  | "not_matured"
  | "expired"
  | "cancelled"
  | "consumed"

export type StartResult =
  | { ok: true; window: GateRecoveryWindow }
  | { ok: false; code: RecoveryRefusal }

export type ReadyResult =
  | { ok: true; keyId: string; recoveryId: string; expiresAt: Date }
  | { ok: false; code: RecoveryRefusal }

/** 160 bits as 32 Crockford base32 characters. */
function encode(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`)
  let out = ""
  for (let i = 0; i < KEY_LENGTH; i++) {
    out = ALPHABET.charAt(Number(value & 31n)) + out
    value >>= 5n
  }
  return out
}

function grouped(raw: string): string {
  const groups = []
  for (let i = 0; i < KEY_LENGTH; i += GROUP)
    groups.push(raw.slice(i, i + GROUP))
  return groups.join("-")
}

/**
 * The key as typed: case-insensitive, dashes and spaces ignored, and the Crockford look-alikes
 * O, I and L read as 0, 1 and 1. Undefined when it cannot be a recovery key.
 */
export function normaliseRecoveryKey(input: string): string | undefined {
  if (input.length > MAX_INPUT_LENGTH) return undefined
  const key = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
  if (key.length !== KEY_LENGTH) return undefined
  return [...key].every((c) => ALPHABET.includes(c)) ? key : undefined
}

const slowHash = (raw: string, salt: Buffer): Buffer =>
  scryptSync(raw, salt, DIGEST_BYTES, SCRYPT)

function audit(
  db: DatabaseSync,
  actor: "gate" | "approver",
  action: string,
  detail: Record<string, string>
): number {
  return append(db, {
    actor,
    action,
    target: "recovery_key",
    detailHash: payloadHash(detail),
  }).seq
}

/**
 * Issues a recovery key, superseding any earlier unused one, and returns it for the one response
 * that shows it. Safe inside the caller's transaction.
 */
export function issueRecoveryKey(db: DatabaseSync, now: Clock): string {
  const raw = encode(randomBytes(KEY_BYTES))
  const keyId = randomUUID()
  const salt = randomBytes(SALT_BYTES)
  const digest = slowHash(raw, salt)
  const at = now().toISOString()
  atomically(db, () => {
    db.prepare(
      "UPDATE recovery_keys SET superseded_at = ? WHERE consumed_at IS NULL AND superseded_at IS NULL"
    ).run(at)
    db.prepare(
      "INSERT INTO recovery_keys (key_id, salt, digest, issued_at) VALUES (?, ?, ?, ?)"
    ).run(keyId, salt.toString("base64url"), digest.toString("base64url"), at)
    audit(db, "gate", "recovery_key.issued", {
      outcome: "issued",
      key_id: keyId,
    })
  })
  return grouped(raw)
}

/**
 * The key id of the active recovery key when the input is it. One scrypt run, compared in
 * constant time. A consumed, superseded or wrong key all match nothing.
 */
function matchActiveKey(db: DatabaseSync, raw: string): string | undefined {
  const row = db
    .prepare(
      "SELECT key_id, salt, digest FROM recovery_keys WHERE consumed_at IS NULL AND superseded_at IS NULL"
    )
    .get()
  if (row === undefined) return undefined
  const stored = Buffer.from(String(row["digest"]), "base64url")
  const candidate = slowHash(raw, Buffer.from(String(row["salt"]), "base64url"))
  return stored.length === candidate.length &&
    timingSafeEqual(stored, candidate)
    ? String(row["key_id"])
    : undefined
}

function keyIsActive(db: DatabaseSync, keyId: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM recovery_keys WHERE key_id = ? AND consumed_at IS NULL AND superseded_at IS NULL"
      )
      .get(keyId) !== undefined
  )
}

type Recovery = {
  id: string
  keyId: string
  startedAt: string
  maturesAt: string
  expiresAt: string
}

function recoveryFrom(row: Record<string, unknown>): Recovery {
  return {
    id: String(row["id"]),
    keyId: String(row["key_id"]),
    startedAt: String(row["started_at"]),
    maturesAt: String(row["matures_at"]),
    expiresAt: String(row["expires_at"]),
  }
}

/** The recovery that is neither cancelled, completed nor expired at `at`, if any. */
function pendingRecovery(db: DatabaseSync, at: Date): Recovery | undefined {
  const row = db
    .prepare(
      "SELECT * FROM recoveries WHERE cancelled_at IS NULL AND completed_at IS NULL AND expires_at > ? ORDER BY started_at DESC LIMIT 1"
    )
    .get(at.toISOString())
  return row === undefined ? undefined : recoveryFrom(row)
}

const windowOf = (recovery: Recovery): GateRecoveryWindow => ({
  startedAt: recovery.startedAt,
  maturesAt: recovery.maturesAt,
  expiresAt: recovery.expiresAt,
})

/** The pending recovery's window, for GET /passkey/status; undefined when none is pending. */
export function pendingRecoveryWindow(
  db: DatabaseSync,
  now: Clock
): GateRecoveryWindow | undefined {
  const pending = pendingRecovery(db, now())
  return pending === undefined ? undefined : windowOf(pending)
}

function refuseStart(db: DatabaseSync, outcome: RecoveryRefusal): StartResult {
  audit(db, "gate", "recovery.start_refused", { outcome })
  return { ok: false, code: outcome }
}

/**
 * Starts the 24-hour delay when the input is the active recovery key. Records the window and
 * audits it; the caller sends the alert. A second start while one is pending is refused, so the
 * delay cannot be restarted by anyone. A refusal stores nothing of the guess.
 */
export function startRecovery(
  db: DatabaseSync,
  input: string,
  now: Clock
): StartResult {
  const at = now()
  const raw = normaliseRecoveryKey(input)
  if (raw === undefined) return refuseStart(db, "malformed")
  const keyId = matchActiveKey(db, raw)
  if (keyId === undefined) return refuseStart(db, "invalid_key")
  return atomically(db, (): StartResult => {
    // Rotated or consumed while the slow hash ran.
    if (!keyIsActive(db, keyId)) return refuseStart(db, "invalid_key")
    if (pendingRecovery(db, at) !== undefined)
      return refuseStart(db, "already_pending")
    const recovery: Recovery = {
      id: randomUUID(),
      keyId,
      startedAt: at.toISOString(),
      maturesAt: new Date(at.getTime() + RECOVERY_DELAY_MS).toISOString(),
      expiresAt: new Date(
        at.getTime() + RECOVERY_DELAY_MS + RECOVERY_WINDOW_MS
      ).toISOString(),
    }
    db.prepare(
      "INSERT INTO recoveries (id, key_id, started_at, matures_at, expires_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      recovery.id,
      keyId,
      recovery.startedAt,
      recovery.maturesAt,
      recovery.expiresAt
    )
    audit(db, "gate", "recovery.started", {
      outcome: "started",
      key_id: keyId,
      recovery_id: recovery.id,
      matures_at: recovery.maturesAt,
      expires_at: recovery.expiresAt,
    })
    return { ok: true, window: windowOf(recovery) }
  })
}

/**
 * Where the key's latest recovery stands at `at`: the recovery when it can be completed now, or
 * why it cannot. Does not check the key itself.
 */
function completable(
  db: DatabaseSync,
  keyId: string,
  at: Date
): { ok: true; recovery: Recovery } | { ok: false; code: RecoveryRefusal } {
  const row = db
    .prepare(
      "SELECT * FROM recoveries WHERE key_id = ? ORDER BY started_at DESC LIMIT 1"
    )
    .get(keyId)
  if (row === undefined) return { ok: false, code: "no_recovery" }
  if (row["completed_at"] !== null) return { ok: false, code: "consumed" }
  if (row["cancelled_at"] !== null) return { ok: false, code: "cancelled" }
  const recovery = recoveryFrom(row)
  if (recovery.expiresAt <= at.toISOString())
    return { ok: false, code: "expired" }
  if (recovery.maturesAt > at.toISOString())
    return { ok: false, code: "not_matured" }
  return { ok: true, recovery }
}

/** Audits a refused completion step. The detail is the outcome only. */
export function refuseRecoveryComplete(
  db: DatabaseSync,
  outcome: string
): void {
  audit(db, "gate", "recovery.complete_refused", { outcome })
}

/**
 * Whether the input is the active recovery key and its recovery may be completed now: matured,
 * not expired, not cancelled and not consumed. Does not consume anything. A refusal is audited.
 */
export function checkRecoveryReady(
  db: DatabaseSync,
  input: string,
  now: Clock
): ReadyResult {
  const refuse = (code: RecoveryRefusal): ReadyResult => {
    refuseRecoveryComplete(db, code)
    return { ok: false, code }
  }
  const raw = normaliseRecoveryKey(input)
  if (raw === undefined) return refuse("malformed")
  const keyId = matchActiveKey(db, raw)
  if (keyId === undefined) return refuse("invalid_key")
  return recoveryReadyFor(db, keyId, now(), refuse)
}

function recoveryReadyFor(
  db: DatabaseSync,
  keyId: string,
  at: Date,
  refuse: (code: RecoveryRefusal) => ReadyResult
): ReadyResult {
  const state = completable(db, keyId, at)
  if (!state.ok) return refuse(state.code)
  return {
    ok: true,
    keyId,
    recoveryId: state.recovery.id,
    expiresAt: new Date(state.recovery.expiresAt),
  }
}

/**
 * In the caller's transaction, right before it enrols the new passkey: checks again that the key
 * is still the active one and the recovery still completable, then consumes both. A refusal is
 * audited and consumes nothing.
 */
export function consumeRecovery(
  db: DatabaseSync,
  keyId: string,
  at: Date
): { ok: true; recoveryId: string } | { ok: false; code: RecoveryRefusal } {
  const refuse = (code: RecoveryRefusal) => {
    refuseRecoveryComplete(db, code)
    return { ok: false, code } as const
  }
  if (!keyIsActive(db, keyId)) return refuse("invalid_key")
  const state = completable(db, keyId, at)
  if (!state.ok) return refuse(state.code)
  db.prepare("UPDATE recovery_keys SET consumed_at = ? WHERE key_id = ?").run(
    at.toISOString(),
    keyId
  )
  db.prepare("UPDATE recoveries SET completed_at = ? WHERE id = ?").run(
    at.toISOString(),
    state.recovery.id
  )
  return { ok: true, recoveryId: state.recovery.id }
}

/** Audits a completed recovery: the consumed key, the recovery and the new credential's hash. */
export function auditRecoveryCompleted(
  db: DatabaseSync,
  keyId: string,
  recoveryId: string,
  credentialSha256: string
): void {
  audit(db, "gate", "recovery.completed", {
    outcome: "completed",
    key_id: keyId,
    recovery_id: recoveryId,
    credential_sha256: credentialSha256,
  })
}

const cancelPayload = (recoveryId: string) => ({
  action: "recovery.cancel",
  recoveryId,
})

/**
 * Prepares the signed ceremony that cancels the pending recovery, binding its id. Undefined when
 * none is pending. A new one supersedes any earlier unused ceremony.
 */
export function prepareRecoveryCancel(db: DatabaseSync, now: Clock) {
  const pending = pendingRecovery(db, now())
  if (pending === undefined) return undefined
  const prepared = prepareControlApproval(
    db,
    "policy.set",
    RECOVERY_KEY_TARGET,
    cancelPayload(pending.id)
  )
  return { ...prepared, challenge: controlApprovalChallenge(prepared) }
}

/**
 * Cancels the pending recovery once an unrevoked passkey has signed the prepared ceremony, and
 * supersedes the recovery key that started it. Returns the replacement key, for the one response
 * that shows it. Throws, changing nothing, when no recovery is pending or the authorization does
 * not verify.
 */
export function cancelRecovery(
  db: DatabaseSync,
  authorization: ControlAuthorization,
  now: Clock
): string {
  const at = now()
  return atomically(db, () => {
    const pending = pendingRecovery(db, at)
    if (pending === undefined) throw new Error("no recovery is pending")
    return withControlApproval(
      db,
      "policy.set",
      RECOVERY_KEY_TARGET,
      payloadHash(cancelPayload(pending.id)),
      authorization,
      () => {
        db.prepare("UPDATE recoveries SET cancelled_at = ? WHERE id = ?").run(
          at.toISOString(),
          pending.id
        )
        const seq = audit(db, "approver", "recovery.cancelled", {
          outcome: "cancelled",
          key_id: pending.keyId,
          recovery_id: pending.id,
        })
        return { result: issueRecoveryKey(db, now), auditSeq: seq }
      }
    )
  })
}
