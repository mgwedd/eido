import { randomBytes } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import type { Surface } from "./surface"
import type { Clock } from "./sessions"
import { atomically } from "./transaction"
import { sha256 } from "./webauthn"

// Single-use enrolment codes (#78). The owner issues one on the Mac, from the control socket
// only, to enrol a phone for the first time or again after a revoke or a lost phone. The code is
// 80 random bits in Crockford base32, shown once and stored only as a SHA-256 hash. It expires
// after ten minutes, works once, and issuing a new one supersedes any earlier unused code.
// Issuing, consuming and every refusal are audited with hashes only.

export const ENROLMENT_CODE_TTL_MS = 10 * 60 * 1000

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const CODE_LENGTH = 16
const GROUP = 4
const MAX_INPUT_LENGTH = 64

export type IssueResult =
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; code: "admin_only" }

export type ConsumeRefusal = "unknown" | "reused" | "expired" | "superseded"

export type ConsumeResult = { ok: true } | { ok: false; code: ConsumeRefusal }

export type CheckResult =
  { ok: true; expiresAt: Date } | { ok: false; code: ConsumeRefusal }

/** 80 bits as 16 Crockford base32 characters. */
function encode(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`)
  let out = ""
  for (let i = 0; i < CODE_LENGTH; i++) {
    out = ALPHABET.charAt(Number(value & 31n)) + out
    value >>= 5n
  }
  return out
}

/**
 * The code as typed: case-insensitive, dashes and spaces ignored, and the Crockford look-alikes
 * O, I and L read as 0, 1 and 1. Undefined when it cannot be a code.
 */
export function normaliseEnrolmentCode(input: string): string | undefined {
  if (input.length > MAX_INPUT_LENGTH) return undefined
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
  if (code.length !== CODE_LENGTH) return undefined
  return [...code].every((c) => ALPHABET.includes(c)) ? code : undefined
}

const hex = (value: string) => sha256(value).toString("hex")

function audit(
  db: DatabaseSync,
  surface: Surface,
  action: string,
  detail: Record<string, string>
): void {
  append(db, {
    actor: surface === "admin" ? "owner" : "approver",
    action,
    target: "enrolment_code",
    detailHash: payloadHash(detail),
  })
}

/** Issues a fresh enrolment code, superseding any earlier unused one. Admin surface only. */
export function issueEnrolmentCode(
  db: DatabaseSync,
  surface: Surface,
  now: Clock
): IssueResult {
  if (surface !== "admin") {
    audit(db, surface, "enrolment_code.issue_refused", {
      outcome: "admin_only",
    })
    return { ok: false, code: "admin_only" }
  }
  const issued = now()
  const expiresAt = new Date(issued.getTime() + ENROLMENT_CODE_TTL_MS)
  const raw = encode(randomBytes(10))
  const codeHash = hex(raw)
  atomically(db, () => {
    db.prepare(
      "UPDATE enrolment_codes SET superseded_at = ? WHERE used_at IS NULL AND superseded_at IS NULL"
    ).run(issued.toISOString())
    db.prepare(
      "INSERT INTO enrolment_codes (code_hash, issued_at, expires_at) VALUES (?, ?, ?)"
    ).run(codeHash, issued.toISOString(), expiresAt.toISOString())
    audit(db, surface, "enrolment_code.issued", {
      outcome: "issued",
      code_sha256: codeHash,
      expires_at: expiresAt.toISOString(),
    })
  })
  const groups = []
  for (let i = 0; i < CODE_LENGTH; i += GROUP)
    groups.push(raw.slice(i, i + GROUP))
  return { ok: true, code: groups.join("-"), expiresAt }
}

function refusal(db: DatabaseSync, codeHash: string): ConsumeRefusal {
  const row = db
    .prepare(
      "SELECT used_at, superseded_at FROM enrolment_codes WHERE code_hash = ?"
    )
    .get(codeHash)
  if (row === undefined) return "unknown"
  if (row["used_at"] !== null) return "reused"
  // The atomic update failed on an unused, current row: only the expiry is left.
  return row["superseded_at"] !== null ? "superseded" : "expired"
}

/**
 * Checks that an enrolment code could be consumed now, without consuming it: the phone's enrol
 * options route (#202) asks before it issues a registration challenge. A refusal is audited.
 */
export function checkEnrolmentCode(
  db: DatabaseSync,
  surface: Surface,
  input: string,
  now: Clock
): CheckResult {
  const at = now()
  const code = normaliseEnrolmentCode(input)
  const codeHash = hex(code ?? input)
  const row =
    code === undefined
      ? undefined
      : db
          .prepare(
            "SELECT expires_at FROM enrolment_codes WHERE code_hash = ? AND used_at IS NULL AND superseded_at IS NULL AND expires_at > ?"
          )
          .get(codeHash, at.toISOString())
  if (row !== undefined) {
    return { ok: true, expiresAt: new Date(String(row["expires_at"])) }
  }
  const reason = code === undefined ? "unknown" : refusal(db, codeHash)
  audit(db, surface, "enrolment_code.refused", {
    outcome: reason,
    code_sha256: codeHash,
  })
  return { ok: false, code: reason }
}

/**
 * Consumes an enrolment code once. Safe inside the caller's transaction, so the phone enrol
 * route (#202) can consume the code and register the credential as one unit.
 */
export function consumeEnrolmentCode(
  db: DatabaseSync,
  surface: Surface,
  input: string,
  now: Clock
): ConsumeResult {
  const at = now()
  const code = normaliseEnrolmentCode(input)
  // A malformed input is hashed as given so the audit row never holds it in clear.
  const codeHash = hex(code ?? input)
  return atomically(db, () => {
    const used =
      code === undefined
        ? 0
        : Number(
            db
              .prepare(
                "UPDATE enrolment_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND superseded_at IS NULL AND expires_at > ?"
              )
              .run(at.toISOString(), codeHash, at.toISOString()).changes
          )
    if (used === 1) {
      audit(db, surface, "enrolment_code.consumed", {
        outcome: "consumed",
        code_sha256: codeHash,
      })
      return { ok: true }
    }
    const reason = code === undefined ? "unknown" : refusal(db, codeHash)
    audit(db, surface, "enrolment_code.refused", {
      outcome: reason,
      code_sha256: codeHash,
    })
    return { ok: false, code: reason }
  })
}
