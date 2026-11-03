import { existsSync, readFileSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import { parseAmountCents } from "./amounts"
import type { SimpleFinClient } from "./client"
import {
  DEFAULT_MAX_DATE_RANGE_DAYS,
  SIMPLEFIN_CONNECTOR,
  type SimpleFinConfig,
} from "./config"

export interface SimpleFinSyncOptions {
  db: DatabaseSync
  client: SimpleFinClient
  config?: Partial<SimpleFinConfig>
  entityAssignments?: Record<string, string>
  now?: () => number
}

export interface SimpleFinSyncResult {
  accountsStored: number
  transactionsStored: number
  unassignedAccounts: number
  malformedAmountsRejected: number
  cursorAdvancedTo: string
  healthMessages: string[]
}

/**
 * Loads entity assignments for accounts:
 * 1. Explicit in-memory mapping from options.
 * 2. Configuration file if provided (JSON object: { [accountId]: entityId }).
 * 3. `entity_assignments` table in SQLite database.
 */
function resolveAccountEntities(
  db: DatabaseSync,
  options: SimpleFinSyncOptions
): Record<string, string> {
  const assignments: Record<string, string> = {}

  // 1. From database table if present
  try {
    const rows = db
      .prepare(
        "SELECT account_ref, entity_id FROM entity_assignments WHERE connector = ?"
      )
      .all(SIMPLEFIN_CONNECTOR)
    for (const row of rows) {
      if (
        typeof row["account_ref"] === "string" &&
        typeof row["entity_id"] === "string"
      ) {
        assignments[row["account_ref"]] = row["entity_id"]
      }
    }
  } catch {
    // entity_assignments table may not exist in minimal schemas
  }

  // 2. From config file
  const configFile = options.config?.entityConfigFile
  if (configFile && existsSync(configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(configFile, "utf-8"))
      if (typeof parsed === "object" && parsed !== null) {
        for (const [accId, entId] of Object.entries(parsed)) {
          if (typeof entId === "string") {
            assignments[accId] = entId
          }
        }
      }
    } catch {
      // Invalid JSON file skipped
    }
  }

  // 3. Explicit assignments in config or options
  if (options.config?.accountEntityAssignments) {
    Object.assign(assignments, options.config.accountEntityAssignments)
  }
  if (options.entityAssignments) {
    Object.assign(assignments, options.entityAssignments)
  }

  // Filter out any assignments where the entity does not exist in `entities` table
  const validAssignments: Record<string, string> = {}
  for (const [accountId, entityId] of Object.entries(assignments)) {
    try {
      const exists = db
        .prepare("SELECT 1 FROM entities WHERE id = ?")
        .get(entityId)
      if (exists !== undefined) {
        validAssignments[accountId] = entityId
      }
    } catch {
      // If entities table does not exist or errors, skip
    }
  }

  return validAssignments
}

export async function syncSimpleFin(
  options: SimpleFinSyncOptions
): Promise<SimpleFinSyncResult> {
  const { db, client } = options
  const nowMs = (options.now ?? Date.now)()
  const nowSec = Math.floor(nowMs / 1000)
  const maxRangeDays =
    options.config?.maxDateRangeDays ?? DEFAULT_MAX_DATE_RANGE_DAYS
  const maxRangeSec = maxRangeDays * 86400

  // 1. Fetch current cursor from `cursors` table
  const cursorRow = db
    .prepare(
      "SELECT cursor FROM cursors WHERE connector = ? AND stream = 'transactions'"
    )
    .get(SIMPLEFIN_CONNECTOR)

  let startDate: number
  if (cursorRow && typeof cursorRow["cursor"] === "string") {
    const parsedCursor = Number(cursorRow["cursor"])
    startDate = Number.isFinite(parsedCursor)
      ? parsedCursor
      : nowSec - maxRangeSec
  } else {
    startDate = nowSec - maxRangeSec
  }

  const endDate = Math.min(startDate + maxRangeSec, nowSec)

  // 2. Query SimpleFIN
  const { accounts, errors } = await client.getAccounts({
    startDate,
    endDate,
  })

  // 3. Resolve entity assignments
  const assignedEntities = resolveAccountEntities(db, options)

  let accountsStored = 0
  let transactionsStored = 0
  let unassignedAccounts = 0
  let malformedAmountsRejected = 0

  const ingestedAt = new Date(nowMs).toISOString()

  // 4. Atomic batch insertion
  db.exec("BEGIN")
  try {
    const upsertAccount = db.prepare(`
      INSERT INTO accounts (id, connector, name, currency, entity_id, balance_cents, balance_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        connector = excluded.connector,
        name = excluded.name,
        currency = excluded.currency,
        entity_id = COALESCE(excluded.entity_id, accounts.entity_id),
        balance_cents = excluded.balance_cents,
        balance_at = excluded.balance_at
    `)

    const upsertTransaction = db.prepare(`
      INSERT INTO transactions (
        id, account_id, entity_id, posted_at, amount_cents, currency, description, category, raw_json, ingested_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        entity_id = excluded.entity_id,
        posted_at = excluded.posted_at,
        amount_cents = excluded.amount_cents,
        currency = excluded.currency,
        description = excluded.description,
        category = excluded.category,
        raw_json = excluded.raw_json,
        ingested_at = excluded.ingested_at
    `)

    for (const account of accounts) {
      const entityId = assignedEntities[account.id] ?? null

      const balanceParsed = parseAmountCents(account.balance)
      const balanceCents = balanceParsed.ok ? balanceParsed.cents : null
      const balanceAt =
        typeof account["balance-date"] === "number"
          ? new Date(account["balance-date"] * 1000).toISOString()
          : null

      upsertAccount.run(
        account.id,
        SIMPLEFIN_CONNECTOR,
        account.name,
        account.currency,
        entityId,
        balanceCents,
        balanceAt
      )
      accountsStored++

      if (entityId === null) {
        // Transactions of an account with no entity are not stored
        unassignedAccounts++
        continue
      }

      for (const tx of account.transactions ?? []) {
        // Posted transactions only
        if (tx.posted === 0 || tx.pending === true) {
          continue
        }

        const amountParsed = parseAmountCents(tx.amount)
        if (!amountParsed.ok) {
          malformedAmountsRejected++
          continue
        }

        const txId = `${account.id}:${tx.id}`
        const postedAt = new Date(tx.posted * 1000).toISOString()
        const rawJson = JSON.stringify(tx)

        upsertTransaction.run(
          txId,
          account.id,
          entityId,
          postedAt,
          amountParsed.cents,
          account.currency,
          tx.description,
          null, // category to be filled by later classification
          rawJson,
          ingestedAt
        )
        transactionsStored++
      }
    }

    // 5. Advance cursor in `cursors` table only after successful batch
    const cursorStr = String(endDate)
    db.prepare(`
      INSERT INTO cursors (connector, stream, cursor, updated_at)
      VALUES (?, 'transactions', ?, ?)
      ON CONFLICT(connector, stream) DO UPDATE SET
        cursor = excluded.cursor,
        updated_at = excluded.updated_at
    `).run(SIMPLEFIN_CONNECTOR, cursorStr, ingestedAt)

    db.exec("COMMIT")

    const healthMessages = [...errors]
    if (unassignedAccounts > 0) {
      healthMessages.push(
        `${unassignedAccounts} account${unassignedAccounts === 1 ? "" : "s"} ${unassignedAccounts === 1 ? "needs" : "need"} an entity`
      )
    }

    return {
      accountsStored,
      transactionsStored,
      unassignedAccounts,
      malformedAmountsRejected,
      cursorAdvancedTo: cursorStr,
      healthMessages,
    }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
