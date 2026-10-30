import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { GateAuditRecordRequest } from "@eido/schemas"
import { LedgerError } from "./errors"
import type { ObligationStatus } from "./types"

/**
 * A local, reversible obligation state change (#104). `done` (Ledger) and `resolve` (Replies
 * owed, waiting on) move an open obligation to `done`; `reopen` moves a done one back to
 * `open`, the only state it can have been marked from. None is an external write.
 */
export type ObligationChange = "done" | "resolve" | "reopen"

const TRANSITIONS: Record<
  ObligationChange,
  { from: ObligationStatus; to: ObligationStatus }
> = {
  done: { from: "open", to: "done" },
  resolve: { from: "open", to: "done" },
  reopen: { from: "done", to: "open" },
}

/** Active and waiting calls together; a full queue refuses work before retaining its arguments. */
export const MAX_OBLIGATION_CALLS = 32

export type ObligationAuditEntry = GateAuditRecordRequest & {
  action: `obligation.${ObligationChange}`
}

/**
 * Where audit entries go: the process entry wires this to `createAuditClient(...).record`
 * (the gate's POST /audit). It is awaited inside the change's transaction, so a sink that
 * rejects rolls the change back and an unaudited change never commits.
 */
export type ObligationAuditSink = (
  entry: ObligationAuditEntry
) => Promise<unknown>

export interface ObligationStateStoreOptions {
  audit: ObligationAuditSink
}

export interface ObligationState {
  id: number
  status: ObligationStatus
}

export interface ObligationStateStore {
  /**
   * Applies `change` to obligation `id` and returns its new state. Fails with a LedgerError:
   * `obligation_not_found`, `invalid_transition` when the obligation is not in the state the
   * change starts from, or `busy` when the queue is full or another store's transaction is open.
   */
  change(id: number, change: ObligationChange): Promise<ObligationState>
  /** Resolves once every queued call has settled; used before closing the database. */
  drain(): Promise<void>
}

// Hashes only: the gate's audit log never sees an obligation's text.
const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

export function createObligationStateStore(
  db: DatabaseSync,
  options: ObligationStateStoreOptions
): ObligationStateStore {
  // node:sqlite has one connection and the audit call is awaited inside the transaction, so
  // calls run one at a time, as in the profile store.
  let tail: Promise<unknown> = Promise.resolve()
  let admitted = 0

  async function apply(
    id: number,
    change: ObligationChange
  ): Promise<ObligationState> {
    // Another store (the profile store) is awaiting its own audit call inside a transaction;
    // joining it would commit or roll back this change with that one.
    if (db.isTransaction) {
      throw new LedgerError("busy", "ledger busy")
    }
    const { from, to } = TRANSITIONS[change]
    db.exec("BEGIN IMMEDIATE")
    try {
      const row = db
        .prepare("SELECT status FROM obligations WHERE id = ?")
        .get(id)
      if (row === undefined) {
        throw new LedgerError("obligation_not_found", "no such obligation")
      }
      if (row["status"] !== from) {
        throw new LedgerError("invalid_transition", `obligation is not ${from}`)
      }
      db.prepare("UPDATE obligations SET status = ? WHERE id = ?").run(to, id)
      await options.audit({
        action: `obligation.${change}`,
        subjectHash: sha256(`obl:${String(id)}`),
        beforeHash: sha256({ id, status: from }),
        afterHash: sha256({ id, status: to }),
      })
      db.exec("COMMIT")
      return { id, status: to }
    } catch (error) {
      // A failed COMMIT may already have ended the transaction; a second error would hide the first.
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    }
  }

  return {
    change(id, change) {
      if (admitted >= MAX_OBLIGATION_CALLS) {
        return Promise.reject(new LedgerError("busy", "ledger busy"))
      }
      admitted++
      const result = tail.then(() => apply(id, change))
      const release = (): void => {
        admitted--
      }
      tail = result.then(release, release)
      return result
    },
    async drain() {
      await tail
    },
  }
}
