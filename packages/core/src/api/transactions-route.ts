import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import type { CoreApiTransactionList } from "@eido/schemas"
import { validateCoreApiTransactionList } from "@eido/schemas"
import { DEFAULT_LIMIT, MAX_LIMIT, param, readCount } from "./obligations-route"

/** GET /transactions (#77): stored bank transactions, read only. */
export const TRANSACTIONS_PATH = "/transactions"

export type TransactionsListResult =
  | { ok: true; body: CoreApiTransactionList }
  | {
      ok: false
      code: "invalid"
      message: string
      fields: { field: string; message: string }[]
    }

/** The ledger is absent while it waits on a default entity; transactions are then all unlinked. */
function ledgerPresent(db: DatabaseSync): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_schema'"
      )
      .get() !== undefined
  )
}

/**
 * Serves GET /transactions?entity=&account=&limit=&offset=: newest first (the transaction's
 * posted time, then its id, so a page boundary never repeats or skips a row). `accounts` lists
 * every account holding a stored transaction, whatever the filters. A transaction's
 * `linkedObligation` is the obligation its `pays` link names (#576), of the same entity.
 */
export function listTransactionsRoute(
  db: DatabaseSync,
  params: URLSearchParams
): TransactionsListResult {
  const errors: { field: string; message: string }[] = []
  const limit = readCount(params, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT, errors)
  const offset = readCount(
    params,
    "offset",
    0,
    Number.MAX_SAFE_INTEGER,
    0,
    errors
  )
  if (errors.length > 0) {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: errors,
    }
  }

  const conditions: string[] = []
  const values: SQLInputValue[] = []
  const entity = param(params, "entity")
  if (entity !== undefined) {
    conditions.push("t.entity_id = ?")
    values.push(entity)
  }
  const account = param(params, "account")
  if (account !== undefined) {
    conditions.push("t.account_id = ?")
    values.push(account)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  const linked = ledgerPresent(db)
    ? {
        columns: "o.id AS obligation_id, o.action AS obligation_action",
        join: `LEFT JOIN obligations o ON o.id = (
                 SELECT CAST(substr(l.dst, 5) AS INTEGER) FROM links l
                 WHERE l.src = 'txn:' || t.id AND l.kind = 'pays' ORDER BY l.dst LIMIT 1)
               AND o.entity_id = t.entity_id`,
      }
    : { columns: "NULL AS obligation_id, NULL AS obligation_action", join: "" }

  const rows = db
    .prepare(
      `SELECT t.id, t.posted_at, t.description, t.amount_cents, t.currency,
              a.id AS account_id, a.name AS account_name,
              e.id AS entity_id, e.name AS entity_name, e.tag AS entity_tag,
              ${linked.columns}
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN entities e ON e.id = t.entity_id
       ${linked.join}
       ${where}
       ORDER BY t.posted_at DESC, t.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...values, limit + 1, offset)
  const accounts = db
    .prepare(
      `SELECT a.id, a.name FROM accounts a
       WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id)
       ORDER BY a.name, a.id`
    )
    .all()

  const body: CoreApiTransactionList = {
    transactions: rows.slice(0, limit).map((row) => ({
      id: String(row["id"]),
      postedAt: String(row["posted_at"]),
      description: String(row["description"]),
      amountCents: Number(row["amount_cents"]),
      currency: String(row["currency"]),
      account: {
        id: String(row["account_id"]),
        name: String(row["account_name"]),
      },
      entity: {
        id: String(row["entity_id"]),
        name: String(row["entity_name"]),
        tag: String(row["entity_tag"]),
      },
      linkedObligation:
        row["obligation_id"] === null
          ? null
          : {
              id: Number(row["obligation_id"]),
              action: String(row["obligation_action"]),
            },
    })),
    accounts: accounts.map((row) => ({
      id: String(row["id"]),
      name: String(row["name"]),
    })),
    nextOffset: rows.length > limit ? offset + limit : null,
  }
  const checked = validateCoreApiTransactionList(body)
  if (!checked.ok) {
    throw new Error(
      `transaction list validation failed: ${checked.errors.join("; ")}`
    )
  }
  return { ok: true, body }
}
