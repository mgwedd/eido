import type { DatabaseSync } from "node:sqlite"
import { writeQueueFor } from "../../db/write-queue"
import { linkPayments } from "../../ledger/payments"
import { parseAmountCents } from "./amounts"
import { pendingBackfillAccounts } from "./accounts"
import type { SimpleFinAccount, SimpleFinClient } from "./client"
import { resolveSimpleFinConfig, SIMPLEFIN_CONNECTOR } from "./config"
import type { SimpleFinConfig } from "./config"

// SimpleFIN sync (#51): reads accounts and posted transactions since the stored cursor, in windows
// no larger than the configured range, and stores each window as one transaction with the cursor
// moved to its end. Upserts on id make a re-read of the same window change nothing. After the
// windows, new debits are matched to the obligations they paid (`linkPayments`, #576).
// An account's entity is the one stored on it (`accounts.entity_id`, set in Settings, #545): a new
// account is stored with none, and sync stores no transactions for it until it has one.

const DAY_SECONDS = 86_400
/** Re-read this much before the cursor: a bank can post a transaction days after it happened. */
export const CURSOR_OVERLAP_SECONDS = 3 * DAY_SECONDS
/** The health schema's limits on messages. */
const MAX_MESSAGES = 20
const MAX_MESSAGE_LENGTH = 500

export interface SimpleFinSyncOptions {
  db: DatabaseSync
  client: SimpleFinClient
  config?: Partial<SimpleFinConfig>
  now?: () => number
}

export interface SimpleFinSyncResult {
  windows: number
  accounts: number
  transactionsStored: number
  /** Accounts with no entity, or one that does not exist: their transactions are not stored. */
  unassignedAccounts: number
  /** Transactions with a malformed amount or a missing field, each rejected and counted. */
  rejectedTransactions: number
  /** `pays` links stored by this run between debits and the obligations they paid. */
  paymentsLinked: number
  /** Unix seconds: the end of the last stored window. */
  cursor: number
  /** SimpleFIN's own errors from this run, scrubbed of URLs. */
  errors: string[]
  /** Health messages for the connector: unassigned accounts and SimpleFIN's own errors. */
  messages: string[]
}

function storedCursor(db: DatabaseSync): number | undefined {
  const row = db
    .prepare(
      "SELECT cursor FROM cursors WHERE connector = ? AND stream = 'transactions'"
    )
    .get(SIMPLEFIN_CONNECTOR)
  const value = Number(row?.["cursor"])
  return row !== undefined && Number.isSafeInteger(value) ? value : undefined
}

export function healthMessages(
  unassigned: number,
  errors: Iterable<string>
): string[] {
  const messages =
    unassigned === 0
      ? []
      : [
          unassigned === 1
            ? "1 account needs an entity"
            : `${String(unassigned)} accounts need an entity`,
        ]
  for (const error of errors) {
    const trimmed = error.trim()
    if (trimmed !== "") messages.push(trimmed.slice(0, MAX_MESSAGE_LENGTH))
  }
  return messages.slice(0, MAX_MESSAGES)
}

interface WindowCounts {
  transactionsStored: number
  rejectedTransactions: number
  unassigned: Set<string>
}

type Statement = ReturnType<DatabaseSync["prepare"]>

interface Statements {
  upsertAccount: Statement
  entityOf: Statement
  upsertTransaction: Statement
}

function statements(db: DatabaseSync): Statements {
  return {
    // The entity is never written here: it is the owner's assignment (#545).
    upsertAccount: db.prepare(`
      INSERT INTO accounts (id, connector, name, currency, entity_id, balance_cents, balance_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        currency = excluded.currency,
        balance_cents = excluded.balance_cents,
        balance_at = excluded.balance_at`),
    entityOf: db.prepare("SELECT entity_id FROM accounts WHERE id = ?"),
    upsertTransaction: db.prepare(`
      INSERT INTO transactions (
        id, account_id, entity_id, posted_at, amount_cents, currency, description, raw_json, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        entity_id = excluded.entity_id,
        posted_at = excluded.posted_at,
        amount_cents = excluded.amount_cents,
        currency = excluded.currency,
        description = excluded.description,
        raw_json = excluded.raw_json`),
  }
}

/** Stores one account and, when it has an entity, its posted transactions. Runs inside a transaction. */
function storeAccount(
  sql: Statements,
  account: SimpleFinAccount,
  ingestedAt: string,
  counts: WindowCounts
): void {
  const balance = parseAmountCents(account.balance)
  sql.upsertAccount.run(
    account.id,
    SIMPLEFIN_CONNECTOR,
    account.name,
    account.currency,
    balance.ok ? balance.cents : null,
    account.balanceDate === undefined
      ? null
      : new Date(account.balanceDate * 1000).toISOString()
  )
  const entity = sql.entityOf.get(account.id)?.["entity_id"]
  if (typeof entity !== "string") {
    counts.unassigned.add(account.id)
    return
  }
  counts.rejectedTransactions += account.rejected
  for (const transaction of account.transactions) {
    if (transaction.pending || transaction.posted === 0) continue
    const amount = parseAmountCents(transaction.amount)
    if (!amount.ok) {
      counts.rejectedTransactions++
      continue
    }
    sql.upsertTransaction.run(
      `${account.id}:${transaction.id}`,
      account.id,
      entity,
      new Date(transaction.posted * 1000).toISOString(),
      amount.cents,
      account.currency,
      transaction.description,
      JSON.stringify(transaction.raw),
      ingestedAt
    )
    counts.transactionsStored++
  }
}

function emptyCounts(): WindowCounts {
  return { transactionsStored: 0, rejectedTransactions: 0, unassigned: new Set() }
}

function storeWindow(
  db: DatabaseSync,
  accounts: readonly SimpleFinAccount[],
  end: number,
  ingestedAt: string
): WindowCounts {
  const counts = emptyCounts()
  const sql = statements(db)
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const account of accounts) storeAccount(sql, account, ingestedAt, counts)
    db.prepare(
      `INSERT INTO cursors (connector, stream, cursor, updated_at)
       VALUES (?, 'transactions', ?, ?)
       ON CONFLICT(connector, stream) DO UPDATE SET
         cursor = excluded.cursor, updated_at = excluded.updated_at`
    ).run(SIMPLEFIN_CONNECTOR, String(end), ingestedAt)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  return counts
}

/**
 * Syncs SimpleFIN from the cursor (less a short overlap) up to now. A failed read leaves the
 * cursor at the end of the last stored window, so the next run resumes there.
 */
export async function syncSimpleFin(
  options: SimpleFinSyncOptions
): Promise<SimpleFinSyncResult> {
  const { db, client } = options
  const { maxDateRangeDays } = resolveSimpleFinConfig(options.config)
  const nowMs = (options.now ?? Date.now)()
  const now = Math.floor(nowMs / 1000)
  const range = maxDateRangeDays * DAY_SECONDS
  const cursor = storedCursor(db)
  let start = Math.min(
    cursor === undefined ? now - range : cursor - CURSOR_OVERLAP_SECONDS,
    now - 1
  )
  const ingestedAt = new Date(nowMs).toISOString()
  const errors = new Set<string>()
  let windows = 0
  let transactionsStored = 0
  let rejectedTransactions = 0
  let unassigned = new Set<string>()
  let accounts = 0
  let end = start
  while (end < now) {
    end = Math.min(start + range, now)
    const read = await client.getAccounts({ startDate: start, endDate: end })
    const counts = storeWindow(db, read.accounts, end, ingestedAt)
    windows++
    accounts = read.accounts.length
    transactionsStored += counts.transactionsStored
    rejectedTransactions += counts.rejectedTransactions
    unassigned = counts.unassigned
    for (const error of read.errors) errors.add(error)
    start = end
  }
  const paymentsLinked = await linkPayments(db)
  return {
    windows,
    accounts,
    transactionsStored,
    paymentsLinked,
    unassignedAccounts: unassigned.size,
    rejectedTransactions,
    cursor: end,
    errors: [...errors],
    messages: healthMessages(unassigned.size, errors),
  }
}

export interface SimpleFinBackfillResult {
  /** Accounts the backfill read: those assigned an entity since their transactions were first read. */
  accounts: number
  transactionsStored: number
  rejectedTransactions: number
  paymentsLinked: number
}

/**
 * Reads the older transactions of every account waiting for a backfill (#545) in one request over
 * the configured maximum range, and stores them under the account's entity. The main cursor does
 * not move. The accounts leave the backfill once the read is stored, including any SimpleFIN no
 * longer returns, so a missing account cannot spend a request on every run.
 */
export async function backfillSimpleFin(
  options: SimpleFinSyncOptions
): Promise<SimpleFinBackfillResult> {
  const { db, client } = options
  const pending = pendingBackfillAccounts(db)
  if (pending.length === 0) {
    return { accounts: 0, transactionsStored: 0, rejectedTransactions: 0, paymentsLinked: 0 }
  }
  const { maxDateRangeDays } = resolveSimpleFinConfig(options.config)
  const nowMs = (options.now ?? Date.now)()
  const now = Math.floor(nowMs / 1000)
  const read = await client.getAccounts({
    startDate: now - maxDateRangeDays * DAY_SECONDS,
    endDate: now,
    accounts: pending,
  })
  const wanted = new Set(pending)
  const counts = emptyCounts()
  const ingestedAt = new Date(nowMs).toISOString()
  await writeQueueFor(db).run(() => {
    const sql = statements(db)
    const done = db.prepare(
      "UPDATE accounts SET backfill_pending = 0 WHERE id = ?"
    )
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const account of read.accounts) {
        if (wanted.has(account.id)) storeAccount(sql, account, ingestedAt, counts)
      }
      for (const id of pending) done.run(id)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  })
  return {
    accounts: pending.length,
    transactionsStored: counts.transactionsStored,
    rejectedTransactions: counts.rejectedTransactions,
    paymentsLinked: await linkPayments(db),
  }
}
