import type { DatabaseSync } from "node:sqlite"
import { insertLinks } from "./store"
import type { Link } from "./types"

// Payment matching (#576): links a bank transaction to the obligation it paid. The rule is
// deterministic and leaves out anything ambiguous, since a wrong link is worse than none.

/** A matched edge is below 1 by the links table's rule; an amount and date match is not certain. */
export const PAYMENT_MATCH_CONFIDENCE = 0.9
/** A bill is often paid up to a month before it is due. */
export const PAYMENT_DAYS_BEFORE_DUE = 30
/** And sometimes a few days late. */
export const PAYMENT_DAYS_AFTER_DUE = 7

const DAY_MS = 86_400_000

export interface PaymentTransaction {
  id: string
  entityId: string
  /** ISO time. */
  postedAt: string
  /** Signed minor units: below zero is money out. */
  amountCents: number
  currency: string
}

export interface PayableObligation {
  id: number
  entityId: string
  /** YYYY-MM-DD. */
  dueAt: string
  /** The amount extracted from its document, in minor units. */
  amountMinor: number
  currency: string
}

function daysFromDue(postedAt: string, dueAt: string): number {
  return (
    (Date.parse(`${postedAt.slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${dueAt}T00:00:00Z`)) /
    DAY_MS
  )
}

function pays(t: PaymentTransaction, o: PayableObligation): boolean {
  if (t.entityId !== o.entityId || t.currency !== o.currency) return false
  if (t.amountCents >= 0 || -t.amountCents !== o.amountMinor) return false
  const days = daysFromDue(t.postedAt, o.dueAt)
  return days >= -PAYMENT_DAYS_BEFORE_DUE && days <= PAYMENT_DAYS_AFTER_DUE
}

/**
 * The `pays` links between transactions and obligations. A debit pays an obligation of the same
 * entity when its amount equals the obligation's amount in the same currency and it posted from
 * PAYMENT_DAYS_BEFORE_DUE days before the due date to PAYMENT_DAYS_AFTER_DUE days after it. A
 * pair is linked only when each side has that one candidate: two bills of the same amount, or two
 * payments, give no link. The bank's description is not compared. Pure; in transaction order.
 */
export function matchPayments(
  transactions: readonly PaymentTransaction[],
  obligations: readonly PayableObligation[]
): Link[] {
  const byTransaction = new Map<string, PayableObligation[]>()
  const candidatesOf = new Map<number, number>()
  for (const t of transactions) {
    const matches = obligations.filter((o) => pays(t, o))
    byTransaction.set(t.id, matches)
    for (const o of matches) {
      candidatesOf.set(o.id, (candidatesOf.get(o.id) ?? 0) + 1)
    }
  }
  const links: Link[] = []
  for (const [id, matches] of byTransaction) {
    const [only, ...others] = matches
    if (only === undefined || others.length > 0) continue
    if (candidatesOf.get(only.id) !== 1) continue
    links.push({
      src: `txn:${id}`,
      dst: `obl:${only.id}`,
      kind: "pays",
      confidence: PAYMENT_MATCH_CONFIDENCE,
      origin: "match",
    })
  }
  return links
}

function ledgerPresent(db: DatabaseSync): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_schema'"
      )
      .get() !== undefined
  )
}

function unlinkedDebits(db: DatabaseSync): PaymentTransaction[] {
  return db
    .prepare(
      `SELECT id, entity_id, posted_at, amount_cents, currency FROM transactions t
       WHERE amount_cents < 0
         AND NOT EXISTS (SELECT 1 FROM links WHERE src = 'txn:' || t.id AND kind = 'pays')
       ORDER BY id`
    )
    .all()
    .map((row) => ({
      id: String(row["id"]),
      entityId: String(row["entity_id"]),
      postedAt: String(row["posted_at"]),
      amountCents: Number(row["amount_cents"]),
      currency: String(row["currency"]),
    }))
}

/**
 * Open and done obligations with a due date and an amount parsed from their document's latest
 * extraction, not yet paid by a linked transaction. Reply-tracking obligations (with a direction)
 * are messages to answer, not bills, and dismissed ones were set aside.
 */
function unpaidObligations(db: DatabaseSync): PayableObligation[] {
  return db
    .prepare(
      `SELECT o.id, o.entity_id, o.due_at,
              json_extract(e.fields_json, '$.amount.value.amount_minor') AS amount_minor,
              json_extract(e.fields_json, '$.amount.value.currency') AS currency
       FROM obligations o
       JOIN extractions e ON e.id = (
         SELECT id FROM extractions
         WHERE doc_id = o.doc_id AND status = 'extracted' ORDER BY id DESC LIMIT 1)
       WHERE o.status <> 'dismissed' AND o.direction IS NULL AND o.due_at IS NOT NULL
         AND json_extract(e.fields_json, '$.amount.status') = 'parsed'
         AND json_type(e.fields_json, '$.amount.value.amount_minor') = 'integer'
         AND json_type(e.fields_json, '$.amount.value.currency') = 'text'
         AND NOT EXISTS (SELECT 1 FROM links WHERE dst = 'obl:' || o.id AND kind = 'pays')`
    )
    .all()
    .map((row) => ({
      id: Number(row["id"]),
      entityId: String(row["entity_id"]),
      dueAt: String(row["due_at"]),
      amountMinor: Number(row["amount_minor"]),
      currency: String(row["currency"]),
    }))
}

/**
 * Matches every unlinked debit against every unpaid obligation and stores the new `pays` links.
 * A database without the ledger (opened at the index schema while the ledger waits on a default
 * entity) has no obligations to match: nothing is done. Returns how many links were stored.
 */
export async function linkPayments(db: DatabaseSync): Promise<number> {
  if (!ledgerPresent(db)) return 0
  const links = matchPayments(unlinkedDebits(db), unpaidObligations(db))
  return links.length === 0 ? 0 : insertLinks(db, links)
}
