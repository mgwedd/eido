import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

const GENESIS_HASH = "0".repeat(64)
const HEX64 = /^[0-9a-f]{64}$/

export type AuditEntry = {
  actor: string
  action: string
  target: string
  detailHash: string
  ts?: string
}

export type VerifyResult =
  | { ok: true; rows: number }
  | {
      ok: false
      brokenAtSeq: number
      reason: "prev_hash_mismatch" | "seq_gap" | "bad_genesis" | "head_mismatch"
    }

type Row = {
  seq: number
  ts: string
  actor: string
  action: string
  target: string
  detail_hash: string
  prev_hash: string
}

function rowHash(r: Row): string {
  const payload = JSON.stringify([
    r.seq,
    r.ts,
    r.actor,
    r.action,
    r.target,
    r.detail_hash,
    r.prev_hash,
  ])
  return createHash("sha256").update(payload, "utf8").digest("hex")
}

function toRow(raw: Record<string, unknown>): Row {
  return {
    seq: Number(raw["seq"]),
    ts: String(raw["ts"]),
    actor: String(raw["actor"]),
    action: String(raw["action"]),
    target: String(raw["target"]),
    detail_hash: String(raw["detail_hash"]),
    prev_hash: String(raw["prev_hash"]),
  }
}

/**
 * Appends one row to the hash chain. Takes only a hash of the detail, never the detail.
 * Runs in its own write transaction, or in a SAVEPOINT when the caller already has one open.
 */
export function append(
  db: DatabaseSync,
  entry: AuditEntry
): { seq: number; rowHash: string } {
  if (!HEX64.test(entry.detailHash)) {
    throw new Error("detailHash must be 64 lowercase hex characters")
  }
  const nested = db.isTransaction
  db.exec(nested ? "SAVEPOINT audit_append" : "BEGIN IMMEDIATE")
  try {
    const last = db
      .prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1")
      .get()
    const prev = last === undefined ? undefined : toRow(last)
    const row: Row = {
      seq: prev === undefined ? 1 : prev.seq + 1,
      ts: entry.ts ?? new Date().toISOString(),
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      detail_hash: entry.detailHash,
      prev_hash: prev === undefined ? GENESIS_HASH : rowHash(prev),
    }
    db.prepare(
      "INSERT INTO audit_log (seq, ts, actor, action, target, detail_hash, prev_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      row.seq,
      row.ts,
      row.actor,
      row.action,
      row.target,
      row.detail_hash,
      row.prev_hash
    )
    db.exec(nested ? "RELEASE audit_append" : "COMMIT")
    return { seq: row.seq, rowHash: rowHash(row) }
  } catch (error) {
    db.exec(
      nested ? "ROLLBACK TO audit_append; RELEASE audit_append" : "ROLLBACK"
    )
    throw error
  }
}

/** Walks the chain from seq 1. `expectedHead` is the rowHash `append` returned for the newest row. */
export function verifyChain(
  db: DatabaseSync,
  opts?: { expectedHead?: string }
): VerifyResult {
  let count = 0
  let expectedPrev = GENESIS_HASH
  let expectedSeq = 1
  let lastHash = GENESIS_HASH
  let lastSeq = 0
  for (const raw of db
    .prepare("SELECT * FROM audit_log ORDER BY seq ASC")
    .iterate()) {
    const row = toRow(raw)
    if (row.seq !== expectedSeq)
      return { ok: false, brokenAtSeq: row.seq, reason: "seq_gap" }
    if (row.prev_hash !== expectedPrev) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: row.seq === 1 ? "bad_genesis" : "prev_hash_mismatch",
      }
    }
    lastHash = rowHash(row)
    lastSeq = row.seq
    expectedPrev = lastHash
    expectedSeq++
    count++
  }
  const head = opts?.expectedHead
  if (head !== undefined && head !== lastHash) {
    return { ok: false, brokenAtSeq: lastSeq, reason: "head_mismatch" }
  }
  return { ok: true, rows: count }
}
