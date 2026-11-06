import type { DatabaseSync } from "node:sqlite"
import type { IntentProposal } from "@eido/gate"
import { validateGateIntentProposal, validateIntent } from "@eido/schemas"
import type { Intent } from "@eido/schemas"
import { localParts } from "../brief/local-time"
import { loadStoredText } from "../extraction/stored-text"
import { lookupOffset } from "../parsers/offsets"
import { fence, toMaterial } from "../inference/fence"
import type { TriageConfig } from "./config"
import type { TriageEvent } from "./store"
import type { TriageDeps } from "./tick"

type Proposal = Omit<IntentProposal, "origin" | "intent"> & { intent: Intent }
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function checked(value: unknown): Proposal | undefined {
  if (!record(value)) return undefined
  const result = validateGateIntentProposal({ ...value, origin: "proactive" })
  if (!result.ok) return undefined
  const intent = validateIntent(result.value.intent)
  if (!intent.ok) return undefined
  return {
    intent: intent.value,
    ...(result.value.injection === undefined
      ? {}
      : { injection: result.value.injection }),
  }
}

function confirmation(
  db: DatabaseSync,
  event: TriageEvent,
  cfg: TriageConfig
): Proposal | undefined {
  if (!/^ext:[1-9]\d*$/.test(event.ref)) return undefined
  const id = event.ref.slice(4)
  const row = db
    .prepare(
      `SELECT x.doc_id, x.fields_json, x.confirmed_at, c.confidence, d.source, t.title
     FROM extractions x JOIN documents d ON d.sha256 = x.doc_id
     JOIN extraction_field_confidence c ON c.extraction_id = x.id AND c.field = ?
     LEFT JOIN document_text t ON t.sha256 = x.doc_id
     WHERE x.id = ? AND x.status = 'extracted'`
    )
    .get(event.fireId, id)
  if (row === undefined || row["confirmed_at"] !== null) return undefined
  const fields: unknown = JSON.parse(String(row["fields_json"]))
  const field: unknown = record(fields) ? fields[event.fireId] : undefined
  if (
    !record(field) ||
    field["confirmed_at"] !== undefined ||
    !record(field["span"])
  )
    return undefined
  const span = field["span"]
  if (event.proposalJson !== undefined) {
    const proposal = checked(JSON.parse(event.proposalJson))
    if (proposal?.intent.kind !== "confirm.field") return undefined
    const args = proposal.intent.args
    return args.extractionId === id &&
      args.field === event.fireId &&
      args.source.docSha256 === row["doc_id"] &&
      args.value.raw === field["raw"] &&
      args.source.start === span["start"] &&
      args.source.end === span["end"]
      ? proposal
      : undefined
  }
  if (
    Number(row["confidence"]) >= cfg.scan.confirmThreshold &&
    field["status"] !== "parse_failed"
  )
    return undefined
  const stored = loadStoredText(db, String(row["doc_id"]))
  const location =
    stored !== null && typeof span["start"] === "number"
      ? lookupOffset(stored.offsets, span["start"])
      : null
  const reasons =
    stored === null
      ? []
      : [...fence(toMaterial(stored.text, { source: "document" })).reasons]
  return checked({
    intent: {
      kind: "confirm.field",
      args: {
        extractionId: id,
        field: event.fireId,
        value: {
          raw: field["raw"],
          ...(field["value"] === undefined ? {} : { typed: field["value"] }),
        },
        source: {
          docSha256: row["doc_id"],
          start: span["start"],
          end: span["end"],
          ...(location?.messageId === undefined
            ? {}
            : { messageId: location.messageId }),
          ...(location?.page === undefined
            ? typeof span["page"] === "number"
              ? { page: span["page"] }
              : {}
            : { page: location.page }),
          ...(location?.line === undefined ? {} : { line: location.line }),
        },
        confidence: row["confidence"],
        threshold: cfg.scan.confirmThreshold,
        documentSource: row["source"],
        ...(typeof row["title"] === "string" && row["title"] !== ""
          ? { documentTitle: row["title"].slice(0, 300) }
          : {}),
      },
    },
    ...(reasons.length === 0 ? {} : { injection: { reasons } }),
  })
}

function dueCard(
  db: DatabaseSync,
  event: TriageEvent,
  now: Date,
  cfg: TriageConfig
): Proposal | undefined {
  if (!/^obl:[1-9]\d*$/.test(event.ref)) return undefined
  const row = db
    .prepare(
      `SELECT entity_id, action, due_at, doc_id, source_span FROM obligations
     WHERE id = ? AND status = 'open' AND direction IS NULL`
    )
    .get(event.ref.slice(4))
  if (row === undefined || typeof row["due_at"] !== "string") return undefined
  const date = row["due_at"]
  if (
    date < localParts(now, cfg.timezone).date ||
    event.fireId !== `${event.kind}:${date}`
  )
    return undefined
  if (
    db
      .prepare(
        `SELECT 1 FROM events WHERE ref = ? AND kind IN ('due-soon', 'due-today') AND disposition = 'card' LIMIT 1`
      )
      .get(event.ref) !== undefined
  )
    return undefined
  // The calendar writer treats all-day RFC3339 values as UTC date markers and its end date is
  // inclusive. Keep both markers on the due date; timezone is used only for today's eligibility.
  return checked({
    intent: {
      kind: "calendar.create",
      args: {
        entity: row["entity_id"],
        title: String(row["action"]).slice(0, 200),
        start: `${date}T00:00:00.000Z`,
        end: `${date}T23:59:59.999Z`,
        allDay: true,
        guests: [],
        description: `Source document: ${String(row["doc_id"])}\nPassage: ${String(row["source_span"])}`,
      },
    },
  })
}

/** Only ledger-backed confirmations and future/current due dates have deterministic card content. */
export function createCardBuilders(
  db: DatabaseSync,
  now: Date,
  cfg: TriageConfig
): TriageDeps["cards"] {
  return {
    "confirm-field": (event) => confirmation(db, event, cfg),
    "due-soon": (event) => dueCard(db, event, now, cfg),
    "due-today": (event) => dueCard(db, event, now, cfg),
  }
}
