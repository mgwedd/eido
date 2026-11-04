import type { DatabaseSync } from "node:sqlite"
import type { CoreApiSimpleFinAccount } from "@eido/schemas"
import { writeQueueFor } from "../../db/write-queue"
import { SIMPLEFIN_CONNECTOR } from "./config"

// The SimpleFIN account-to-entity assignment (#545). It lives on the stored account
// (`accounts.entity_id`): sync inserts a new account with no entity and never overwrites one, so
// the owner's choice in Settings is what sync stores transactions under. A first assignment marks
// the account for a backfill of the transactions sync skipped while it had no entity.

function toAccount(row: Record<string, unknown>): CoreApiSimpleFinAccount {
  const balance = row["balance_cents"]
  const balanceAt = row["balance_at"]
  const entity = row["entity_id"]
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    currency: String(row["currency"]),
    balanceCents: typeof balance === "number" ? balance : null,
    balanceAt: typeof balanceAt === "string" ? balanceAt : null,
    entityId: typeof entity === "string" ? entity : null,
    backfillPending: row["backfill_pending"] === 1,
  }
}

const COLUMNS =
  "id, name, currency, balance_cents, balance_at, entity_id, backfill_pending"

/** Every stored SimpleFIN account, by name then id. */
export function listSimpleFinAccounts(
  db: DatabaseSync
): CoreApiSimpleFinAccount[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM accounts WHERE connector = ? ORDER BY name, id`
    )
    .all(SIMPLEFIN_CONNECTOR)
    .map(toAccount)
}

/** How many stored SimpleFIN accounts have no entity: sync stores none of their transactions. */
export function countUnassignedAccounts(db: DatabaseSync): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM accounts WHERE connector = ? AND entity_id IS NULL"
    )
    .get(SIMPLEFIN_CONNECTOR)
  return Number(row?.["n"] ?? 0)
}

/** Ids of the accounts waiting for a backfill of their older transactions. */
export function pendingBackfillAccounts(db: DatabaseSync): string[] {
  return db
    .prepare(
      "SELECT id FROM accounts WHERE connector = ? AND backfill_pending = 1 ORDER BY id"
    )
    .all(SIMPLEFIN_CONNECTOR)
    .map((row) => String(row["id"]))
}

export type AssignResult =
  | { status: "assigned"; account: CoreApiSimpleFinAccount }
  | { status: "unknown_account" }
  | { status: "unknown_entity" }

/**
 * Assigns `entityId` to the stored SimpleFIN account `accountId`, on the connection's write queue.
 * A change of entity moves the account's stored transactions to the new one. An account that had
 * no entity is marked for a backfill: sync skipped its transactions until now.
 */
export async function assignSimpleFinAccount(
  db: DatabaseSync,
  accountId: string,
  entityId: string
): Promise<AssignResult> {
  return writeQueueFor(db).run((): AssignResult => {
    const current = db
      .prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ? AND connector = ?`)
      .get(accountId, SIMPLEFIN_CONNECTOR)
    if (current === undefined) return { status: "unknown_account" }
    const known = db
      .prepare("SELECT 1 FROM entities WHERE id = ?")
      .get(entityId)
    if (known === undefined) return { status: "unknown_entity" }
    const account = toAccount(current)
    if (account.entityId === entityId) return { status: "assigned", account }
    const backfillPending = account.backfillPending || account.entityId === null
    db.exec("BEGIN IMMEDIATE")
    try {
      db.prepare(
        "UPDATE accounts SET entity_id = ?, backfill_pending = ? WHERE id = ?"
      ).run(entityId, backfillPending ? 1 : 0, accountId)
      db.prepare(
        "UPDATE transactions SET entity_id = ? WHERE account_id = ?"
      ).run(entityId, accountId)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
    return {
      status: "assigned",
      account: { ...account, entityId, backfillPending },
    }
  })
}
