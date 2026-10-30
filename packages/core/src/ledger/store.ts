import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import type { SourceSpan } from "@eido/schemas"
import type { EntityKind } from "../profile/types"
import { INJECTION_REASONS } from "../inference/fence"
import type { InjectionReason } from "../inference/fence"
import { LedgerError } from "./errors"
import type {
  ExtractionFieldName,
  ExtractionInput,
  Link,
  LinkEndpoint,
  LinkKind,
  Obligation,
  ObligationFilter,
  ObligationInput,
  ObligationSource,
  ObligationStatus,
} from "./types"

type Row = Record<string, unknown>

const FIELD_NAMES = [
  "action",
  "party",
  "reference_number",
  "amount",
  "due_date",
] as const satisfies readonly ExtractionFieldName[]

const text = (row: Row, key: string): string => String(row[key])
/** A nullable TEXT column. */
const optionalText = (row: Row, key: string): string | null => {
  const value = row[key]
  return typeof value === "string" ? value : null
}

/**
 * Run `work` in a savepoint, so a ledger write is atomic and still composes with a caller's
 * own transaction (an extraction and its obligation written together by #46).
 */
function atomically<T>(db: DatabaseSync, work: () => T): T {
  db.exec("SAVEPOINT ledger_write")
  try {
    const result = work()
    db.exec("RELEASE ledger_write")
    return result
  } catch (error) {
    db.exec("ROLLBACK TO ledger_write")
    db.exec("RELEASE ledger_write")
    throw error
  }
}

function requireDocument(db: DatabaseSync, docId: string): void {
  if (
    db.prepare("SELECT 1 FROM documents WHERE sha256 = ?").get(docId) ===
    undefined
  ) {
    throw new LedgerError("document_not_found", "no such document")
  }
}

function isSpan(value: unknown): value is SourceSpan {
  if (typeof value !== "object" || value === null) return false
  const start: unknown = Reflect.get(value, "start")
  const end: unknown = Reflect.get(value, "end")
  const optional = (key: string, type: "string" | "number"): boolean => {
    const field: unknown = Reflect.get(value, key)
    return field === undefined || typeof field === type
  }
  return (
    optional("message_id", "string") &&
    optional("page", "number") &&
    optional("line", "number") &&
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start
  )
}

function parseSpan(json: string): SourceSpan {
  const value: unknown = JSON.parse(json)
  // The column's CHECK admits only such spans; a failure here means the file was edited by hand.
  if (!isSpan(value)) throw new Error("stored source span is malformed")
  return value
}

function parseReasons(json: string): InjectionReason[] {
  const value: unknown = JSON.parse(json)
  if (
    !Array.isArray(value) ||
    !value.every(
      (reason: unknown): reason is InjectionReason =>
        typeof reason === "string" &&
        INJECTION_REASONS.some((known) => known === reason)
    )
  )
    throw new Error("stored injection reasons are malformed")
  return value
}

/** Store one extraction and its per-field confidence rows. Returns the extraction id. */
export function insertExtraction(
  db: DatabaseSync,
  input: ExtractionInput
): number {
  requireDocument(db, input.docId)
  const confidences: [ExtractionFieldName, number][] = []
  if (input.status === "extracted") {
    for (const field of FIELD_NAMES) {
      const present = input.fields[field] !== undefined
      const confidence = input.confidence[field]
      if (present !== (confidence !== undefined)) {
        throw new LedgerError(
          "invalid_confidence",
          `field ${field}: a confidence is required exactly when the field is present`
        )
      }
      if (confidence === undefined) continue
      if (!(confidence >= 0 && confidence <= 1)) {
        throw new LedgerError(
          "invalid_confidence",
          `field ${field}: confidence must be between 0 and 1`
        )
      }
      confidences.push([field, confidence])
    }
  }
  const fieldsJson =
    input.status === "extracted" ? JSON.stringify(input.fields) : "{}"
  return atomically(db, () => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO extractions (doc_id, schema, status, fields_json, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.docId,
        input.schema,
        input.status,
        fieldsJson,
        input.model,
        input.createdAt
      )
    const id = Number(lastInsertRowid)
    const insertConfidence = db.prepare(
      "INSERT INTO extraction_field_confidence (extraction_id, field, confidence) VALUES (?, ?, ?)"
    )
    for (const [field, confidence] of confidences) {
      insertConfidence.run(id, field, confidence)
    }
    return id
  })
}

/** Set an extraction's confirmed_at. It is set once; a second call fails. */
export function confirmExtraction(
  db: DatabaseSync,
  id: number,
  at: string
): void {
  const row = db
    .prepare("SELECT confirmed_at FROM extractions WHERE id = ?")
    .get(id)
  if (row === undefined) {
    throw new LedgerError("extraction_not_found", "no such extraction")
  }
  if (row["confirmed_at"] !== null) {
    throw new LedgerError("already_confirmed", "extraction already confirmed")
  }
  db.prepare("UPDATE extractions SET confirmed_at = ? WHERE id = ?").run(at, id)
}

/**
 * Store one obligation. It always links to its source document and span: a missing document or
 * span fails with a LedgerError, never a silent skip. Returns the obligation id.
 */
export function insertObligation(
  db: DatabaseSync,
  input: ObligationInput
): number {
  if (
    (input.injectionSuspected ?? false) !==
    (input.injectionReasons?.length ?? 0) > 0
  ) {
    throw new LedgerError(
      "invalid_injection_provenance",
      "injection flag must match the presence of reasons"
    )
  }
  requireDocument(db, input.docId)
  if (!isSpan(input.span)) {
    throw new LedgerError(
      "invalid_span",
      "source span needs integer start >= 0 and end > start"
    )
  }
  if (
    db.prepare("SELECT 1 FROM entities WHERE id = ?").get(input.entityId) ===
    undefined
  ) {
    throw new LedgerError("entity_not_found", "no such entity")
  }
  // A document has one entity, and an obligation belongs to it (migration v2, #259).
  if (
    db
      .prepare("SELECT entity_id FROM documents WHERE sha256 = ?")
      .get(input.docId)?.["entity_id"] !== input.entityId
  ) {
    throw new LedgerError(
      "entity_mismatch",
      "obligation entity differs from its document entity"
    )
  }
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO obligations (entity_id, party, action, due_at, status, doc_id, source_span, injection_suspected, injection_reasons, direction, thread_id, anchor_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.entityId,
      input.party ?? null,
      input.action,
      input.dueAt ?? null,
      input.status,
      input.docId,
      JSON.stringify(input.span),
      input.injectionSuspected ? 1 : 0,
      JSON.stringify(input.injectionReasons ?? []),
      input.direction ?? null,
      input.threadId ?? null,
      input.anchorMessageId ?? null
    )
  return Number(lastInsertRowid)
}

function toObligation(row: Row): Obligation {
  return {
    id: Number(row["id"]),
    entity: {
      id: text(row, "entity_id"),
      // The entities.kind column has a CHECK constraint limiting it to EntityKind.
      kind: text(row, "entity_kind") as EntityKind,
      name: text(row, "entity_name"),
      tag: text(row, "entity_tag"),
    },
    party: optionalText(row, "party"),
    action: text(row, "action"),
    dueAt: optionalText(row, "due_at"),
    // The obligations.status column has a CHECK constraint limiting it to ObligationStatus.
    status: text(row, "status") as ObligationStatus,
    docId: text(row, "doc_id"),
    span: parseSpan(text(row, "source_span")),
    injectionSuspected: row["injection_suspected"] === 1,
    injectionReasons: parseReasons(text(row, "injection_reasons")),
    direction:
      row["direction"] === "owed" || row["direction"] === "waiting"
        ? row["direction"]
        : null,
    threadId: optionalText(row, "thread_id"),
    anchorMessageId: optionalText(row, "anchor_message_id"),
    resolutionReason: row["resolution_reason"] === "replied" ? "replied" : null,
  }
}

/** Obligations matching every given filter, ordered by due date (no due date last), then id. */
export function listObligations(
  db: DatabaseSync,
  filter: ObligationFilter = {}
): Obligation[] {
  return db
    .prepare(
      `SELECT o.id, o.entity_id, e.kind AS entity_kind, e.name AS entity_name, e.tag AS entity_tag,
              o.party, o.action, o.due_at, o.status, o.doc_id, o.source_span, o.injection_suspected, o.injection_reasons,
              o.direction, o.thread_id, o.anchor_message_id, o.resolution_reason
       FROM obligations o JOIN entities e ON e.id = o.entity_id
       WHERE ($entityId IS NULL OR o.entity_id = $entityId)
         AND ($status IS NULL OR o.status = $status)
         AND ($dueBefore IS NULL OR o.due_at < $dueBefore)
       ORDER BY o.due_at IS NULL, o.due_at, o.id`
    )
    .all({
      entityId: filter.entityId ?? null,
      status: filter.status ?? null,
      dueBefore: filter.dueBefore ?? null,
    })
    .map(toObligation)
}

/** Where an obligation came from: its document, the document's blob and the stored span. */
export function getObligationSource(
  db: DatabaseSync,
  id: number
): ObligationSource | null {
  const row = db
    .prepare(
      `SELECT o.doc_id, d.blob_path, o.source_span, o.injection_suspected, o.injection_reasons
       FROM obligations o JOIN documents d ON d.sha256 = o.doc_id WHERE o.id = ?`
    )
    .get(id)
  if (row === undefined) return null
  return {
    docId: text(row, "doc_id"),
    blobPath: optionalText(row, "blob_path"),
    span: parseSpan(text(row, "source_span")),
    injectionSuspected: row["injection_suspected"] === 1,
    injectionReasons: parseReasons(text(row, "injection_reasons")),
  }
}

/** Store links; one already stored (same src, dst and kind) is left as is. Returns how many were new. */
export function insertLinks(db: DatabaseSync, links: readonly Link[]): number {
  return atomically(db, () => {
    const insert = db.prepare(
      `INSERT INTO links (src, dst, kind, confidence, origin) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (src, dst, kind) DO NOTHING`
    )
    let inserted = 0
    for (const link of links) {
      const params: SQLInputValue[] = [
        link.src,
        link.dst,
        link.kind,
        link.confidence,
        link.origin,
      ]
      inserted += Number(insert.run(...params).changes)
    }
    return inserted
  })
}

/** Every link with `id` at either end, ordered by src, dst and kind. */
export function linksFor(db: DatabaseSync, id: LinkEndpoint): Link[] {
  return db
    .prepare(
      `SELECT src, dst, kind, confidence, origin FROM links
       WHERE src = $id OR dst = $id ORDER BY src, dst, kind`
    )
    .all({ id })
    .map((row) => ({
      // The links table's CHECK constraints limit these columns to the Link types.
      src: text(row, "src") as LinkEndpoint,
      dst: text(row, "dst") as LinkEndpoint,
      kind: text(row, "kind") as LinkKind,
      confidence: Number(row["confidence"]),
      origin: text(row, "origin") as Link["origin"],
    }))
}
