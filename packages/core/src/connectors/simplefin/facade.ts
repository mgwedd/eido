import type { DatabaseSync } from "node:sqlite"
import type { SimpleFinClient } from "./client"
import type { SimpleFinConfig } from "./config"
import { syncSimpleFin, type SimpleFinSyncResult } from "./sync"

export interface StoredAccount {
  id: string
  connector: string
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
  rawJson: string
  ingestedAt: string
}

export interface TransactionFilter {
  accountId?: string
  entityId?: string
  limit?: number
}

export interface SimpleFinFacadeDeps {
  db: DatabaseSync
  client: SimpleFinClient
  config?: Partial<SimpleFinConfig>
  entityAssignments?: Record<string, string>
}

export interface SimpleFinFacade {
  listAccounts(): Promise<StoredAccount[]>
  listTransactions(filter?: TransactionFilter): Promise<StoredTransaction[]>
  sync(): Promise<SimpleFinSyncResult>
}

export function createSimpleFinFacade(
  deps: SimpleFinFacadeDeps
): SimpleFinFacade {
  const { db, client, config, entityAssignments } = deps

  return {
    async listAccounts(): Promise<StoredAccount[]> {
      const rows = db
        .prepare(
          `SELECT id, connector, name, currency, entity_id, balance_cents, balance_at
           FROM accounts WHERE connector = 'simplefin' ORDER BY name`
        )
        .all()

      return rows.map((r) => ({
        id: String(r["id"]),
        connector: String(r["connector"]),
        name: String(r["name"]),
        currency: String(r["currency"]),
        entityId: typeof r["entity_id"] === "string" ? r["entity_id"] : null,
        balanceCents:
          typeof r["balance_cents"] === "number" ? r["balance_cents"] : null,
        balanceAt:
          typeof r["balance_at"] === "string" ? r["balance_at"] : null,
      }))
    },

    async listTransactions(
      filter: TransactionFilter = {}
    ): Promise<StoredTransaction[]> {
      let query = `
        SELECT t.id, t.account_id, t.entity_id, t.posted_at, t.amount_cents,
               t.currency, t.description, t.category, t.raw_json, t.ingested_at
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE a.connector = 'simplefin'
      `
      const params: unknown[] = []

      if (filter.accountId !== undefined) {
        query += " AND t.account_id = ?"
        params.push(filter.accountId)
      }
      if (filter.entityId !== undefined) {
        query += " AND t.entity_id = ?"
        params.push(filter.entityId)
      }

      query += " ORDER BY t.posted_at DESC, t.id DESC"

      if (filter.limit !== undefined && filter.limit > 0) {
        query += " LIMIT ?"
        params.push(filter.limit)
      }

      const rows = db.prepare(query).all(...params)

      return rows.map((r) => ({
        id: String(r["id"]),
        accountId: String(r["account_id"]),
        entityId: String(r["entity_id"]),
        postedAt: String(r["posted_at"]),
        amountCents: Number(r["amount_cents"]),
        currency: String(r["currency"]),
        description: String(r["description"]),
        category: typeof r["category"] === "string" ? r["category"] : null,
        rawJson: String(r["raw_json"]),
        ingestedAt: String(r["ingested_at"]),
      }))
    },

    async sync(): Promise<SimpleFinSyncResult> {
      return syncSimpleFin({
        db,
        client,
        config,
        entityAssignments,
      })
    },
  }
}
