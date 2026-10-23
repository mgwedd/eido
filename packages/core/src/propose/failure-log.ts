import type { DatabaseSync } from "node:sqlite"

// The rejection log of the propose pipeline, in eido-data.db. A row says when a request was
// rejected, which pack it was built from and the failure codes. It never holds email text, the
// request text or a payload body.

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS proposal_failures (
  id INTEGER PRIMARY KEY,
  failed_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  context_pack_id TEXT NOT NULL,
  failure_codes_json TEXT NOT NULL
)`

export interface ProposalFailureRow {
  failedAt: string
  requestId: string
  contextPackId: string
  /** Codes only (for example `schema_mismatch`), in the order they occurred, without repeats. */
  failureCodes: string[]
}

/** Create the `proposal_failures` table if it does not exist. Idempotent. */
export function ensureProposalFailures(db: DatabaseSync): void {
  db.exec(CREATE_TABLE)
}

export function recordProposalFailure(
  db: DatabaseSync,
  row: ProposalFailureRow
): void {
  ensureProposalFailures(db)
  db.prepare(
    "INSERT INTO proposal_failures (failed_at, request_id, context_pack_id, failure_codes_json) VALUES (?, ?, ?, ?)"
  ).run(
    row.failedAt,
    row.requestId,
    row.contextPackId,
    JSON.stringify(row.failureCodes)
  )
}
