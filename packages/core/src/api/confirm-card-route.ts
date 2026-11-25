import type { DatabaseSync } from "node:sqlite"
import { GateRequestError } from "@eido/gate"
import type { IntentClient } from "@eido/gate"
import type { CoreApiConfirmCardResponse, CoreApiError } from "@eido/schemas"
import { writeQueueFor } from "../db/write-queue"
import { confirmFieldProposal } from "../triage/cards"
import type { TriageConfig } from "../triage/config"

// POST /extractions/confirm-card (#852): the confirm card behind a deferred extraction line of the
// morning brief. The line carries only the extraction id, so core picks the field: the
// extraction's lowest-confidence field that is not yet confirmed (ties by field name, the order the
// triage scan and `deferredText` use). A pending `confirm.field` intent for that field is returned
// as it is; otherwise the card is proposed through the gate with origin proactive, built by the
// same builder triage uses. Core never executes anything: the owner approves in the queue.

export const CONFIRM_CARD_PATH = "/extractions/confirm-card"

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS deferred_confirm_cards (
  extraction_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (extraction_id, field)
)`

export interface ConfirmCardDeps {
  /** eido-data.db: extractions, the triage events and `deferred_confirm_cards`. */
  db: DatabaseSync
  /** The gate's intent API: `propose` stores the card, `status` says whether a stored one is pending. */
  gate: Pick<IntentClient, "propose" | "status">
  /** The triage settings, read per call: the confidence threshold and the owner's timezone can change. */
  config: () => Promise<TriageConfig>
  now?: () => Date
}

export type ConfirmCardResult =
  | { ok: true; status: 200 | 201; body: CoreApiConfirmCardResponse }
  | { ok: false; code: CoreApiError["error"]["code"]; message: string }

/** Opens the confirm card for the extraction with this id (from a validated `CoreApiConfirmCardRequest`). */
export type ConfirmCardResolver = (
  extractionId: number
) => Promise<ConfirmCardResult>

type Field = CoreApiConfirmCardResponse["field"]

const FIELDS: readonly Field[] = [
  "action",
  "party",
  "reference_number",
  "amount",
  "due_date",
]

const isField = (value: string): value is Field =>
  FIELDS.some((field) => field === value)

export function queueHref(intentId: string): string {
  return `/queue?intent=${encodeURIComponent(intentId)}`
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  )
}

/** The lowest-confidence field of the extraction that is unconfirmed and still needs a card. */
function pickField(
  db: DatabaseSync,
  extractionId: number,
  threshold: number
): Field | undefined {
  const row = db
    .prepare(
      `SELECT c.field FROM extractions x
       JOIN extraction_field_confidence c ON c.extraction_id = x.id
       WHERE x.id = ? AND x.status = 'extracted' AND x.confirmed_at IS NULL
         AND json_extract(x.fields_json, '$.' || c.field || '.confirmed_at') IS NULL
         AND (c.confidence < ? OR json_extract(x.fields_json, '$.' || c.field || '.status') = 'parse_failed')
       ORDER BY c.confidence, c.field LIMIT 1`
    )
    .get(extractionId, threshold)
  const field = row === undefined ? undefined : String(row["field"])
  return field !== undefined && isField(field) ? field : undefined
}

/** Intent ids already proposed for the field, by this route and by triage. */
function knownIntentIds(
  db: DatabaseSync,
  extractionId: number,
  field: Field
): string[] {
  const ids: string[] = []
  if (hasTable(db, "deferred_confirm_cards")) {
    const row = db
      .prepare(
        "SELECT intent_id FROM deferred_confirm_cards WHERE extraction_id = ? AND field = ?"
      )
      .get(extractionId, field)
    if (row !== undefined) ids.push(String(row["intent_id"]))
  }
  if (hasTable(db, "events")) {
    for (const row of db
      .prepare(
        `SELECT intent_id FROM events
         WHERE kind = 'confirm-field' AND ref = ? AND fire_id = ?
           AND disposition = 'card' AND intent_id IS NOT NULL
         ORDER BY decided_at DESC`
      )
      .all(`ext:${String(extractionId)}`, field))
      ids.push(String(row["intent_id"]))
  }
  return ids
}

/** The first of these intents the gate still holds as a pending confirm.field, else undefined. */
async function pendingIntent(
  gate: Pick<IntentClient, "status">,
  ids: readonly string[]
): Promise<string | undefined> {
  for (const id of ids) {
    try {
      const status = await gate.status(id)
      if (status.kind === "confirm.field" && status.state === "pending")
        return status.id
    } catch (error) {
      // The gate no longer knows the intent (its store was reset): it holds nothing. Any other
      // failure, including an unreachable gate, is the caller's to report.
      if (!(error instanceof GateRequestError && error.status === 404))
        throw error
    }
  }
  return undefined
}

async function resolve(
  deps: ConfirmCardDeps,
  extractionId: number
): Promise<ConfirmCardResult> {
  const notFound: ConfirmCardResult = {
    ok: false,
    code: "not_found",
    message: "no unconfirmed field to confirm for this extraction",
  }
  const cfg = await deps.config()
  const field = pickField(deps.db, extractionId, cfg.scan.confirmThreshold)
  if (field === undefined) return notFound

  const existing = await pendingIntent(
    deps.gate,
    knownIntentIds(deps.db, extractionId, field)
  )
  if (existing !== undefined)
    return {
      ok: true,
      status: 200,
      body: {
        intentId: existing,
        field,
        created: false,
        queueHref: queueHref(existing),
      },
    }

  const proposal = confirmFieldProposal(deps.db, extractionId, field, cfg)
  if (proposal === undefined) return notFound
  let stored: Awaited<ReturnType<IntentClient["propose"]>>
  try {
    stored = await deps.gate.propose({ ...proposal, origin: "proactive" })
  } catch (error) {
    if (error instanceof GateRequestError)
      return {
        ok: false,
        code: "gate_refused",
        message: "the gate refused the confirm card",
      }
    throw error
  }
  if (stored.state === "rejected")
    return {
      ok: false,
      code: "gate_refused",
      message: "the gate's policy refused the confirm card",
    }

  const createdAt = (deps.now?.() ?? new Date()).toISOString()
  await writeQueueFor(deps.db).run(() => {
    deps.db.exec(CREATE_TABLE)
    deps.db
      .prepare(
        "INSERT INTO deferred_confirm_cards (extraction_id, field, intent_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (extraction_id, field) DO UPDATE SET intent_id = excluded.intent_id, created_at = excluded.created_at"
      )
      .run(extractionId, field, stored.id, createdAt)
  })
  return {
    ok: true,
    status: 201,
    body: {
      intentId: stored.id,
      field,
      created: true,
      queueHref: queueHref(stored.id),
    },
  }
}

/**
 * The POST /extractions/confirm-card work. Errors: not_found (no such extraction, or nothing in
 * it left to confirm; nothing is proposed), gate_refused (the gate or its policy refused the card)
 * and, thrown for the handler to answer, GateUnavailableError. Calls for one extraction run one at
 * a time, so a second call sees the card the first one proposed.
 */
export function createConfirmCardResolver(
  deps: ConfirmCardDeps
): ConfirmCardResolver {
  const running = new Map<number, Promise<unknown>>()
  return async (extractionId) => {
    const before = running.get(extractionId) ?? Promise.resolve()
    const run = before.then(
      () => resolve(deps, extractionId),
      () => resolve(deps, extractionId)
    )
    running.set(extractionId, run)
    try {
      return await run
    } finally {
      if (running.get(extractionId) === run) running.delete(extractionId)
    }
  }
}
