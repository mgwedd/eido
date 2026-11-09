import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { IntentProposal } from "@eido/gate"
import { scoreEvent } from "./score"
import type { EventKind, ScoreSignals } from "./score"

export type EventSource = "extraction" | "reply" | "due"
export type Disposition = "ledger" | "digest" | "card"

export type NewEvent = {
  source: EventSource
  kind: EventKind
  /** Stable identity of the thing, such as `obligation:42:due-soon`. */
  triggerKey: string
  /** Identity of this firing, such as a message id or the date crossed. */
  fireId: string
  /** The ledger entry the event points at: `obl:<id>` or `ext:<id>`. */
  ref: string
  signals: ScoreSignals
  receivedAt: string
  proposal?: Omit<IntentProposal, "origin">
}

/** A queued event, as the card builders see it. */
export type TriageEvent = {
  id: string
  source: EventSource
  kind: EventKind
  triggerKey: string
  fireId: string
  ref: string
  score: number
  proposalJson?: string
}

/** An event that went to the digest, for the brief's overflow line. */
export type DigestEvent = TriageEvent & {
  /** Why it was not a card: `budget`, or the gate's refusal. */
  reason: string
  decidedAt: string
}

/**
 * Records an event, scored. The same `(triggerKey, fireId)` is recorded once: reprocessing a
 * source (resync, restart, re-run) returns the stored id with `deduped: true`. Call it inside
 * `writeQueueFor(db).run` so it never lands in another store's open transaction.
 */
export function emitEvent(
  db: DatabaseSync,
  event: NewEvent
): { id: string; deduped: boolean } {
  const id = randomUUID()
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO events
         (id, source, kind, trigger_key, fire_id, ref, score, received_at, proposal_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      event.source,
      event.kind,
      event.triggerKey,
      event.fireId,
      event.ref,
      scoreEvent(event.kind, event.signals),
      event.receivedAt,
      event.proposal === undefined ? null : JSON.stringify(event.proposal)
    )
  if (inserted.changes > 0) return { id, deduped: false }
  const existing = db
    .prepare("SELECT id FROM events WHERE trigger_key = ? AND fire_id = ?")
    .get(event.triggerKey, event.fireId)
  return { id: String(existing?.["id"]), deduped: true }
}

type Row = Record<string, unknown>

function toEvent(row: Row): TriageEvent {
  return {
    id: String(row["id"]),
    source: String(row["source"]) as EventSource,
    kind: String(row["kind"]) as EventKind,
    triggerKey: String(row["trigger_key"]),
    fireId: String(row["fire_id"]),
    ref: String(row["ref"]),
    score: Number(row["score"]),
    ...(typeof row["proposal_json"] === "string"
      ? { proposalJson: row["proposal_json"] }
      : {}),
  }
}

/** Events not decided yet, highest score first (older first among equals). */
export function queuedEvents(db: DatabaseSync): TriageEvent[] {
  return db
    .prepare(
      `SELECT * FROM events WHERE disposition IS NULL
       ORDER BY score DESC, received_at, id`
    )
    .all()
    .map(toEvent)
}

export function cardsDecidedBetween(
  db: DatabaseSync,
  start: string,
  end: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE disposition = 'card' AND decided_at >= ? AND decided_at < ?`
    )
    .get(start, end)
  return Number(row?.["n"])
}

export function decideEvent(
  db: DatabaseSync,
  id: string,
  decision: {
    disposition: Disposition
    reason?: string
    intentId?: string
    decidedAt: string
  }
): void {
  db.prepare(
    `UPDATE events SET disposition = ?, reason = ?, intent_id = ?, decided_at = ?
     WHERE id = ? AND disposition IS NULL`
  ).run(
    decision.disposition,
    decision.reason ?? null,
    decision.intentId ?? null,
    decision.decidedAt,
    id
  )
}

/**
 * The events pushed to the digest since `since` that the brief has not listed yet, highest score
 * first. Each carries its `ref`, so the brief can link it to its ledger entry.
 */
export function listDigestEvents(db: DatabaseSync, since: Date): DigestEvent[] {
  return db
    .prepare(
      `SELECT * FROM events
       WHERE disposition = 'digest' AND shown_in_brief_at IS NULL AND decided_at >= ?
       ORDER BY score DESC, decided_at, id`
    )
    .all(since.toISOString())
    .map((row) => ({
      ...toEvent(row),
      reason: String(row["reason"]),
      decidedAt: String(row["decided_at"]),
    }))
}

/** Marks digest events as listed in a brief, so the next brief leaves them out. */
export function markShownInBrief(
  db: DatabaseSync,
  ids: readonly string[],
  at: Date
): void {
  const mark = db.prepare(
    `UPDATE events SET shown_in_brief_at = ?
     WHERE id = ? AND disposition = 'digest' AND shown_in_brief_at IS NULL`
  )
  for (const id of ids) mark.run(at.toISOString(), id)
}
