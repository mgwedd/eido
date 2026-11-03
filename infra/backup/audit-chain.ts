// Verifies the gate's audit hash chain in a database file. It mirrors `verifyChain` in
// packages/gate/src/internal/audit.ts: infra may not import gate internals, so the row hash is
// restated here, and audit-chain.test.ts pins it to a literal. Row i must carry seq i and a
// prev_hash equal to the SHA-256 of row i-1 (the genesis row carries 64 zeros).
import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

const GENESIS_HASH = "0".repeat(64)

export type ChainResult =
  | { ok: true; rows: number }
  | { ok: false; brokenAtSeq: number; reason: string }

function rowHash(r: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        Number(r["seq"]),
        String(r["ts"]),
        String(r["actor"]),
        String(r["action"]),
        String(r["target"]),
        String(r["detail_hash"]),
        String(r["prev_hash"]),
      ]),
      "utf8"
    )
    .digest("hex")
}

export function verifyAuditChain(db: DatabaseSync): ChainResult {
  let rows = 0
  let expectedPrev = GENESIS_HASH
  for (const row of db
    .prepare("SELECT * FROM audit_log ORDER BY seq ASC")
    .iterate()) {
    const seq = Number(row["seq"])
    if (seq !== rows + 1)
      return { ok: false, brokenAtSeq: seq, reason: "sequence gap" }
    if (String(row["prev_hash"]) !== expectedPrev)
      return {
        ok: false,
        brokenAtSeq: seq,
        reason: seq === 1 ? "bad genesis" : "prev_hash mismatch",
      }
    expectedPrev = rowHash(row)
    rows++
  }
  return { ok: true, rows }
}
