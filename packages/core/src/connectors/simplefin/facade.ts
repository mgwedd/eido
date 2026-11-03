import type { DatabaseSync } from "node:sqlite"
import { SIMPLEFIN_CONNECTOR } from "./config"

// Read verbs over the stored SimpleFIN ledger. There is no write, transfer or payment verb: the
// connector is read-only (invariant 4), and only the sync writes these tables.

export interface StoredAccount {
  id: string
  name: string
  currency: string
  entityId: string | null
  balanceCents: number | null
  balanceAt: string | null
}

export interface StoredTransaction {
  id: string
  accountId: string
  entityId: string
  postedAt: string
  amountCents: number
  currency: string
  description: string
  category: string | null
}

export interface TransactionFilter {
  accountId?: string
  entityId?: string
  limit?: number
}

export interface SimpleFinFacade {
  listAccounts(): StoredAccount[]
  listTransactions(filter?: TransactionFilter): StoredTransaction[]
}

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null

export function createSimpleFinFacade(db: DatabaseSync): SimpleFinFacade {
  return {
    listAccounts() {
      return db
        .prepare(
          `SELECT id, name, currency, entity_id, balance_cents, balance_at
           FROM accounts WHERE connector = ? ORDER BY name, id`
        )
        .all(SIMPLEFIN_CONNECTOR)
        .map((row) => ({
          id: String(row["id"]),
          name: String(row["name"]),
          currency: String(row["currency"]),
          entityId: textOrNull(row["entity_id"]),
          balanceCents:
            typeof row["balance_cents"] === "number"
              ? row["balance_cents"]
              : null,
          balanceAt: textOrNull(row["balance_at"]),
        }))
    },
    listTransactions(filter = {}) {
      return db
        .prepare(
          `SELECT t.id, t.account_id, t.entity_id, t.posted_at, t.amount_cents, t.currency,
                  t.description, t.category
           FROM transactions t JOIN accounts a ON a.id = t.account_id
           WHERE a.connector = ?1
             AND (?2 IS NULL OR t.account_id = ?2)
             AND (?3 IS NULL OR t.entity_id = ?3)
           ORDER BY t.posted_at DESC, t.id DESC
           LIMIT ?4`
        )
        .all(
          SIMPLEFIN_CONNECTOR,
          filter.accountId ?? null,
          filter.entityId ?? null,
          filter.limit ?? -1
        )
        .map((row) => ({
          id: String(row["id"]),
          accountId: String(row["account_id"]),
          entityId: String(row["entity_id"]),
          postedAt: String(row["posted_at"]),
          amountCents: Number(row["amount_cents"]),
          currency: String(row["currency"]),
          description: String(row["description"]),
          category: textOrNull(row["category"]),
        }))
    },
  }
}
