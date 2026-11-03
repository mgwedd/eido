import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import type {
  CoreApiError,
  CoreApiObligationList,
  CoreApiObligationState,
  SourceSpan,
} from "@eido/schemas"
import { validateCoreApiObligationList } from "@eido/schemas"
import { LedgerError } from "../ledger/errors"
import type {
  ObligationChange,
  ObligationStateStore,
} from "../ledger/obligation-state"

/** POST /obligations/:id/done, /resolve and /reopen (#104). */
export const OBLIGATION_CHANGE_PATH =
  /^\/obligations\/([^/]+)\/(done|resolve|reopen)$/

export type ObligationChangeResult =
  | { ok: true; body: CoreApiObligationState }
  | {
      ok: false
      code: CoreApiError["error"]["code"]
      message: string
      fields?: { field: string; message: string }[]
    }

export type ObligationsListResult =
  | { ok: true; body: CoreApiObligationList }
  | {
      ok: false
      code: "invalid"
      message: string
      fields: { field: string; message: string }[]
    }

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

const ID = /^[1-9][0-9]{0,15}$/
const DIGITS = /^\d+$/

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
  errors: { field: string; message: string }[]
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

function toObligationEntry(
  row: Record<string, unknown>
): CoreApiObligationList["obligations"][number] {
  const id = Number(row["id"])
  const action = String(row["action"])
  const party = typeof row["party"] === "string" ? row["party"] : null
  const dueAt = typeof row["due_at"] === "string" ? row["due_at"] : null
  const status = row["status"] as "open" | "done" | "dismissed"
  const direction =
    row["direction"] === "owed" || row["direction"] === "waiting"
      ? row["direction"]
      : null
  const updatedAt =
    typeof row["updated_at"] === "string" ? row["updated_at"] : null
  const documentTitle =
    typeof row["document_title"] === "string"
      ? row["document_title"]
      : undefined
  const span = JSON.parse(String(row["source_span"])) as SourceSpan

  return {
    id,
    action,
    party,
    dueAt,
    status,
    direction,
    hasDraftIntent: false,
    updatedAt,
    entity: {
      id: String(row["entity_id"]),
      name: String(row["entity_name"]),
      tag: String(row["entity_tag"]),
    },
    source: {
      documentId: String(row["doc_id"]),
      span,
      ...(documentTitle ? { title: documentTitle } : {}),
    },
  }
}

/**
 * Serves GET /obligations?entity=&status=&limit=&offset= from the ledger.
 */
export function listObligationsRoute(
  db: DatabaseSync,
  params: URLSearchParams
): ObligationsListResult {
  const errors: { field: string; message: string }[] = []
  const limit = readCount(params, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT, errors)
  const offset = readCount(
    params,
    "offset",
    0,
    Number.MAX_SAFE_INTEGER,
    0,
    errors
  )

  const rawStatus = param(params, "status")
  let status: "open" | "done" | "dismissed" | undefined
  if (rawStatus !== undefined) {
    if (
      rawStatus === "open" ||
      rawStatus === "done" ||
      rawStatus === "dismissed"
    ) {
      status = rawStatus
    } else {
      errors.push({
        field: "status",
        message: "must be one of: open, done, dismissed",
      })
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: errors,
    }
  }

  const conditions: string[] = []
  const values: SQLInputValue[] = []

  const entity = param(params, "entity")
  if (entity !== undefined) {
    conditions.push("o.entity_id = ?")
    values.push(entity)
  }

  if (status !== undefined) {
    conditions.push("o.status = ?")
    values.push(status)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const rows = db
    .prepare(
      `SELECT o.id, o.action, o.party, o.due_at, o.status, o.direction, o.updated_at,
              o.source_span, o.doc_id,
              e.id AS entity_id, e.name AS entity_name, e.tag AS entity_tag,
              dt.title AS document_title
       FROM obligations o
       JOIN entities e ON e.id = o.entity_id
       JOIN documents d ON d.sha256 = o.doc_id
       LEFT JOIN document_text dt ON dt.sha256 = d.sha256
       ${where}
       ORDER BY o.due_at ASC NULLS LAST, o.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...values, limit + 1, offset) as Record<string, unknown>[]

  const more = rows.length > limit
  const selected = rows.slice(0, limit)

  const body: CoreApiObligationList = {
    obligations: selected.map(toObligationEntry),
    nextOffset: more ? offset + limit : null,
  }

  const checked = validateCoreApiObligationList(body)
  if (!checked.ok) {
    throw new Error(
      `obligation list validation failed: ${checked.errors.join("; ")}`
    )
  }

  return { ok: true, body }
}

/**
 * Applies the change named by a path that matched OBLIGATION_CHANGE_PATH. The body carries
 * nothing; it must be the empty JSON object, which keeps the route behind the JSON content type
 * that every core write requires.
 */
export async function changeObligation(
  store: ObligationStateStore,
  match: RegExpExecArray,
  body: unknown
): Promise<ObligationChangeResult> {
  const rawId = match[1] ?? ""
  // The path pattern admits only the three changes.
  const change = match[2] as ObligationChange
  const id = Number(rawId)
  if (!ID.test(rawId) || !Number.isSafeInteger(id)) {
    return { ok: false, code: "not_found", message: "no such obligation" }
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length > 0
  ) {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: [{ field: "", message: "must be an empty object" }],
    }
  }
  try {
    return { ok: true, body: await store.change(id, change) }
  } catch (error) {
    if (!(error instanceof LedgerError)) throw error
    if (error.code === "obligation_not_found") {
      return { ok: false, code: "not_found", message: "no such obligation" }
    }
    if (error.code === "invalid_transition") {
      return { ok: false, code: "invalid_transition", message: error.message }
    }
    if (error.code === "busy") {
      return { ok: false, code: "busy", message: "ledger busy, retry" }
    }
    throw error
  }
}
