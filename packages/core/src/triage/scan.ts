import type { DatabaseSync } from "node:sqlite"
import { daysBetween, localParts } from "../brief/local-time"
import { writeQueueFor } from "../db/write-queue"
import { validateTriageConfig } from "./config"
import type { TriageConfig } from "./config"
import type { EventKind } from "./score"
import { emitEvent } from "./store"
import type { NewEvent } from "./store"

type Row = Record<string, unknown>

const DAY_MS = 86_400_000

const HAS_AMOUNT =
  "EXISTS (SELECT 1 FROM extractions e WHERE e.doc_id = o.doc_id AND json_type(e.fields_json, '$.amount') IS NOT NULL)"

function dueKind(
  daysToDue: number,
  dueSoonDays: number
): EventKind | undefined {
  if (daysToDue < 0) return "overdue"
  if (daysToDue === 0) return "due-today"
  return daysToDue <= dueSoonDays ? "due-soon" : undefined
}

function ledgerEvents(
  db: DatabaseSync,
  now: Date,
  cfg: TriageConfig
): NewEvent[] {
  const today = localParts(now, cfg.timezone).date
  const receivedAt = now.toISOString()
  const since = new Date(now.getTime() - cfg.scan.lookbackDays * DAY_MS)
  const events: NewEvent[] = []

  // Own obligations (no reply direction): a due stage once per due date, else "new" once.
  const own = db
    .prepare(
      `SELECT o.id, o.due_at, o.doc_id, ${HAS_AMOUNT} AS money, d.ingested_at
       FROM obligations o JOIN documents d ON d.sha256 = o.doc_id
       WHERE o.status = 'open' AND o.direction IS NULL
       ORDER BY o.id`
    )
    .all()
  for (const row of own) {
    const id = Number(row["id"])
    const dueAt = typeof row["due_at"] === "string" ? row["due_at"] : undefined
    const daysToDue =
      dueAt === undefined ? undefined : daysBetween(today, dueAt)
    const kind =
      daysToDue === undefined
        ? undefined
        : dueKind(daysToDue, cfg.scan.dueSoonDays)
    const signals = {
      ...(daysToDue === undefined ? {} : { daysToDue }),
      moneyPresent: Number(row["money"]) === 1,
    }
    if (kind !== undefined && dueAt !== undefined) {
      events.push({
        source: "due",
        kind,
        triggerKey: `obligation:${String(id)}:due`,
        fireId: `${kind}:${dueAt}`,
        ref: `obl:${String(id)}`,
        signals,
        receivedAt,
      })
    } else if (String(row["ingested_at"]) > since.toISOString()) {
      events.push({
        source: "extraction",
        kind: "new-obligation",
        triggerKey: `obligation:${String(id)}:new`,
        fireId: "created",
        ref: `obl:${String(id)}`,
        signals,
        receivedAt,
      })
    }
  }

  // Replies owed and waiting-on: one event per open reply obligation and anchor message.
  const replies = db
    .prepare(
      `SELECT o.id, o.direction, o.anchor_message_id, ${HAS_AMOUNT} AS money, t.occurred_at
       FROM obligations o LEFT JOIN document_text t ON t.sha256 = o.doc_id
       WHERE o.status = 'open' AND o.direction IS NOT NULL
       ORDER BY o.id`
    )
    .all()
  for (const row of replies) {
    const id = String(row["id"])
    const occurred =
      typeof row["occurred_at"] === "string"
        ? Date.parse(row["occurred_at"])
        : Number.NaN
    events.push({
      source: "reply",
      kind: row["direction"] === "owed" ? "reply-owed" : "waiting-on",
      triggerKey: `obligation:${id}:reply`,
      fireId: String(row["anchor_message_id"] ?? "anchor"),
      ref: `obl:${id}`,
      signals: {
        moneyPresent: Number(row["money"]) === 1,
        ...(Number.isNaN(occurred)
          ? {}
          : {
              threadAgeDays: Math.max(
                0,
                Math.floor((now.getTime() - occurred) / DAY_MS)
              ),
            }),
      },
      receivedAt,
    })
  }

  // Extractions with a field the owner still has to confirm.
  const confirm = db
    .prepare(
      `SELECT x.id, json_type(x.fields_json, '$.amount') IS NOT NULL AS money
       FROM extractions x
       WHERE x.status = 'extracted' AND x.confirmed_at IS NULL AND x.created_at > ?
         AND EXISTS (SELECT 1 FROM extraction_field_confidence c
                     WHERE c.extraction_id = x.id AND c.confidence < ?)
       ORDER BY x.id`
    )
    .all(since.toISOString(), cfg.scan.confirmThreshold)
  for (const row of confirm as Row[]) {
    events.push({
      source: "extraction",
      kind: "confirm-field",
      triggerKey: `extraction:${String(row["id"])}:confirm`,
      fireId: "extracted",
      ref: `ext:${String(row["id"])}`,
      signals: { moneyPresent: Number(row["money"]) === 1 },
      receivedAt,
    })
  }
  return events
}

/**
 * Emits the events the ledger implies right now: a due stage (due soon, due today, overdue) for
 * each open obligation, once per due date; a new obligation; a reply owed or waited on; an
 * extraction to confirm. The ledger holds no read state, so a message the owner has already read
 * is as much a candidate as an unread one. Re-running emits nothing new. Reads the ledger only.
 */
export function scanLedgerEvents(
  db: DatabaseSync,
  now: Date,
  cfg: TriageConfig
): Promise<{ emitted: number }> {
  validateTriageConfig(cfg)
  return writeQueueFor(db).run(() => {
    let emitted = 0
    for (const event of ledgerEvents(db, now, cfg)) {
      if (!emitEvent(db, event).deduped) emitted += 1
    }
    return { emitted }
  })
}
