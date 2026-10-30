import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import type {
  CoreApiDocumentField,
  CoreApiDocumentList,
  CoreApiDocumentSummary,
  CoreApiDocumentView,
  ExtractedFields,
} from "@eido/schemas"
import { validateExtractedFields } from "@eido/schemas"
import { DEFAULT_CONFIDENCE_THRESHOLD } from "../extraction/pipeline"
import { LIVE_DOCUMENT_PREDICATE } from "../index/heads"
import { tokenize } from "../index/text"

export interface DocumentsDeps {
  /** The data DB holding documents, their text and the extraction ledger. */
  db: DatabaseSync
  /** Confidence a field needs to count as verified without a confirmation. */
  threshold?: number
}

type FieldError = { field: string; message: string }

export type DocumentsResult =
  | { ok: true; body: CoreApiDocumentList | CoreApiDocumentView }
  | {
      ok: false
      code: "invalid" | "bad_request" | "not_found" | "method_not_allowed"
      message: string
      fields?: FieldError[]
    }

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

const LIST_PATH = "/documents"
const VIEW_PATH = /^\/documents\/([^/]+)$/
const SHA256 = /^[0-9a-f]{64}$/
const DIGITS = /^\d+$/

const FIELD_NAMES = [
  "action",
  "party",
  "reference_number",
  "amount",
  "due_date",
] as const

const SUMMARY_COLUMNS = `d.sha256, t.title, d.source, d.source_ref, d.mime, d.ingested_at,
  t.occurred_at, e.id AS entity_id, e.kind AS entity_kind, e.name AS entity_name,
  e.tag AS entity_tag`

const SUMMARY_FROM = `FROM documents d
  JOIN document_text t ON t.sha256 = d.sha256
  JOIN entities e ON e.id = d.entity_id`

/**
 * Serves `GET /documents` (list, filters, text search) and `GET /documents/:sha256` (viewer).
 * Returns null when the path is not a documents route.
 */
export function documentsRoute(
  method: string,
  path: string,
  params: URLSearchParams,
  deps: DocumentsDeps
): DocumentsResult | null {
  const view = VIEW_PATH.exec(path)
  if (path !== LIST_PATH && view === null) return null
  if (method !== "GET") {
    return {
      ok: false,
      code: "method_not_allowed",
      message: "method not allowed",
    }
  }
  if (view === null) return listDocuments(deps.db, params)
  return viewDocument(
    deps.db,
    view[1] ?? "",
    params,
    deps.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD
  )
}

/** A query parameter with surrounding whitespace removed; empty means absent. */
function param(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim()
  return value === undefined || value === "" ? undefined : value
}

function readCount(
  params: URLSearchParams,
  name: string,
  min: number,
  max: number,
  fallback: number,
  errors: FieldError[]
): number {
  const raw = param(params, name)
  if (raw === undefined) return fallback
  const value = DIGITS.test(raw) ? Number(raw) : NaN
  if (!(value >= min && value <= max)) {
    errors.push({
      field: name,
      message: `must be an integer from ${min} to ${max}`,
    })
  }
  return value
}

function listDocuments(
  db: DatabaseSync,
  params: URLSearchParams
): DocumentsResult {
  const errors: FieldError[] = []
  const limit = readCount(params, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT, errors)
  const offset = readCount(
    params,
    "offset",
    0,
    Number.MAX_SAFE_INTEGER,
    0,
    errors
  )
  if (errors.length > 0) {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: errors,
    }
  }

  const conditions = [LIVE_DOCUMENT_PREDICATE]
  const values: SQLInputValue[] = []
  for (const [name, column] of [
    ["entity", "d.entity_id"],
    ["type", "d.mime"],
    ["source", "d.source"],
  ] as const) {
    const value = param(params, name)
    if (value === undefined) continue
    conditions.push(`${column} = ?`)
    values.push(value)
  }

  const q = param(params, "q")
  let from = SUMMARY_FROM
  let order = "d.ingested_at DESC, d.sha256"
  if (q !== undefined) {
    const terms = tokenize(q)
    // Text with no searchable terms (only punctuation) matches nothing.
    if (terms.length === 0) return { ok: true, body: emptyList() }
    from += " JOIN document_fts ON document_fts.rowid = t.rowid"
    // Terms are letters and digits only, so quoting each one is a safe FTS5 phrase.
    conditions.push("document_fts MATCH ?")
    values.push(terms.map((term) => `"${term}"`).join(" AND "))
    order = `bm25(document_fts, 5.0, 1.0), ${order}`
  }

  const rows = db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} ${from}
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`
    )
    .all(...values, limit + 1, offset)
  const more = rows.length > limit
  const body: CoreApiDocumentList = {
    documents: rows.slice(0, limit).map(summary),
    nextOffset: more ? offset + limit : null,
  }
  return { ok: true, body }
}

function emptyList(): CoreApiDocumentList {
  return { documents: [], nextOffset: null }
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (typeof value !== "string") {
    throw new Error(`stored ${column} is not text`)
  }
  return value
}

function nullableText(
  row: Record<string, unknown>,
  column: string
): string | null {
  return row[column] === null ? null : text(row, column)
}

function entityKind(value: string): CoreApiDocumentSummary["entity"]["kind"] {
  if (value === "personal" || value === "property" || value === "company") {
    return value
  }
  throw new Error("stored entity kind is unknown")
}

function summary(row: Record<string, unknown>): CoreApiDocumentSummary {
  return {
    sha256: text(row, "sha256"),
    name: nullableText(row, "title"),
    source: text(row, "source"),
    sourceRef: text(row, "source_ref"),
    type: text(row, "mime"),
    entity: {
      id: text(row, "entity_id"),
      kind: entityKind(text(row, "entity_kind")),
      name: text(row, "entity_name"),
      tag: text(row, "entity_tag"),
    },
    ingestedAt: text(row, "ingested_at"),
    occurredAt: nullableText(row, "occurred_at"),
  }
}

type Line = CoreApiDocumentView["lines"][number]

function splitLines(body: string): Line[] {
  const lines: Line[] = []
  let start = 0
  body.split("\n").forEach((lineText, i) => {
    lines.push({ n: i + 1, start, text: lineText })
    start += lineText.length + 1
  })
  return lines
}

/** The 1-based line holding UTF-16 offset `at`, which must lie within the text. */
function lineOf(lines: readonly Line[], at: number): number {
  let low = 0
  let high = lines.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((lines[mid]?.start ?? 0) <= at) low = mid
    else high = mid - 1
  }
  return low + 1
}

function readSpan(
  params: URLSearchParams,
  length: number
): { start: number; end: number } | null | string {
  const rawStart = param(params, "start")
  const rawEnd = param(params, "end")
  if (rawStart === undefined && rawEnd === undefined) return null
  if (rawStart === undefined || rawEnd === undefined) {
    return "start and end must be given together"
  }
  if (!DIGITS.test(rawStart) || !DIGITS.test(rawEnd)) {
    return "start and end must be non-negative integers"
  }
  const start = Number(rawStart)
  const end = Number(rawEnd)
  if (!(start < end && end <= length)) {
    return "span is outside the document text"
  }
  return { start, end }
}

function viewDocument(
  db: DatabaseSync,
  sha256: string,
  params: URLSearchParams,
  threshold: number
): DocumentsResult {
  const notFound: DocumentsResult = {
    ok: false,
    code: "not_found",
    message: "no such document",
  }
  if (!SHA256.test(sha256)) return notFound
  const row = db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, t.body ${SUMMARY_FROM} WHERE d.sha256 = ?`
    )
    .get(sha256)
  if (row === undefined) return notFound
  const body = text(row, "body")
  const span = readSpan(params, body.length)
  if (typeof span === "string") {
    return { ok: false, code: "bad_request", message: span }
  }
  const lines = splitLines(body)
  const view: CoreApiDocumentView = {
    document: summary(row),
    lines,
    highlight:
      span === null
        ? null
        : {
            ...span,
            text: body.slice(span.start, span.end),
            fromLine: lineOf(lines, span.start),
            toLine: lineOf(lines, span.end - 1),
          },
    extractions: extractionsFor(db, sha256, body, lines, threshold),
  }
  return { ok: true, body: view }
}

function storedFields(json: string): ExtractedFields {
  const result = validateExtractedFields(JSON.parse(json))
  if (!result.ok) throw new Error("stored extraction fields are malformed")
  return result.value
}

function extractionsFor(
  db: DatabaseSync,
  sha256: string,
  body: string,
  lines: readonly Line[],
  threshold: number
): CoreApiDocumentView["extractions"] {
  const confidenceOf = db.prepare(
    "SELECT field, confidence FROM extraction_field_confidence WHERE extraction_id = ?"
  )
  return db
    .prepare(
      `SELECT id, fields_json, created_at, confirmed_at FROM extractions
       WHERE doc_id = ? AND status = 'extracted' ORDER BY id`
    )
    .all(sha256)
    .map((row) => {
      const id = Number(row["id"])
      const confirmedAt = nullableText(row, "confirmed_at")
      const confidence = new Map(
        confidenceOf
          .all(id)
          .map((c) => [text(c, "field"), Number(c["confidence"])] as const)
      )
      const fields = storedFields(text(row, "fields_json"))
      const out: CoreApiDocumentField[] = []
      for (const name of FIELD_NAMES) {
        const field = fields[name]
        if (field === undefined) continue
        const score = confidence.get(name)
        if (score === undefined) {
          throw new Error("stored extraction field has no confidence")
        }
        const typed = "status" in field ? field : null
        const quoteMatches =
          field.span.end <= body.length &&
          body.slice(field.span.start, field.span.end) === field.raw
        out.push({
          field: name,
          raw: field.raw,
          value: typed?.value ?? null,
          span: field.span,
          line:
            field.span.start < body.length
              ? lineOf(lines, field.span.start)
              : null,
          confidence: score,
          verified:
            quoteMatches &&
            (typed === null || typed.status === "parsed") &&
            (score >= threshold || confirmedAt !== null),
        })
      }
      return {
        id,
        createdAt: text(row, "created_at"),
        confirmedAt,
        fields: out,
      }
    })
}
