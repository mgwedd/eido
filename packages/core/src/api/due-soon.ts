import type { DatabaseSync } from "node:sqlite"
import type { CoreApiTodayDueSoon, SourceSpan } from "@eido/schemas"
import type { EntityKind } from "../profile/types"

export const DUE_SOON_DAYS = 90
export const DUE_SOON_DEFAULT_PAGE_SIZE = 50
export const DUE_SOON_MAX_PAGE_SIZE = 200

export type DueSoonPage = CoreApiTodayDueSoon
type DueSoonEntry = DueSoonPage["entries"][number]

export interface DueSoonOptions {
  now?: Date
  timezone?: string | null
  entityId?: string
  limit?: number
  offset?: number
}

type Row = Record<string, unknown>

function requiredText(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== "string") throw new Error(`stored ${key} is not text`)
  return value
}

function positiveId(row: Row): number {
  const value = row["id"]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("stored obligation id is invalid")
  }
  return value
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value !== "string") throw new Error(`stored ${key} is not text`)
  return value
}

function entityKind(value: string): EntityKind {
  if (value === "personal" || value === "property" || value === "company") {
    return value
  }
  throw new Error("stored entity kind is invalid")
}

function isSourceSpan(value: unknown): value is SourceSpan {
  if (typeof value !== "object" || value === null) return false
  const start: unknown = Reflect.get(value, "start")
  const end: unknown = Reflect.get(value, "end")
  const validOptional = (key: string, type: "number" | "string"): boolean => {
    const field: unknown = Reflect.get(value, key)
    return field === undefined || typeof field === type
  }
  return (
    Number.isInteger(start) &&
    typeof start === "number" &&
    start >= 0 &&
    Number.isInteger(end) &&
    typeof end === "number" &&
    end > start &&
    validOptional("message_id", "string") &&
    validOptional("page", "number") &&
    validOptional("line", "number")
  )
}

function sourceSpan(row: Row): SourceSpan {
  const value: unknown = JSON.parse(requiredText(row, "source_span"))
  if (!isSourceSpan(value)) throw new Error("stored source span is malformed")
  return value
}

function calendarDate(now: Date, timezone: string): string {
  if (!Number.isFinite(now.getTime()))
    throw new RangeError("now must be a valid date")
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now)
  } catch {
    throw new RangeError("timezone must be a valid IANA timezone")
  }
  const part = (type: "year" | "month" | "day"): string | undefined =>
    parts.find((candidate) => candidate.type === type)?.value
  const year = part("year")
  const month = part("month")
  const day = part("day")
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("could not read calendar date in timezone")
  }
  return `${year.padStart(4, "0")}-${month}-${day}`
}

function addCalendarDays(date: string, days: number): string {
  const [yearText, monthText, dayText] = date.split("-")
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined
  ) {
    throw new Error("calendar date is malformed")
  }
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const value = new Date(Date.UTC(year, month - 1, day))
  value.setUTCDate(value.getUTCDate() + days)
  return [
    String(value.getUTCFullYear()).padStart(4, "0"),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-")
}

function validPageSize(limit: number | undefined): number {
  const selected = limit ?? DUE_SOON_DEFAULT_PAGE_SIZE
  if (
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > DUE_SOON_MAX_PAGE_SIZE
  ) {
    throw new RangeError(
      `limit must be between 1 and ${DUE_SOON_MAX_PAGE_SIZE}`
    )
  }
  return selected
}

function validOffset(offset: number | undefined): number {
  const selected = offset ?? 0
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new RangeError("offset must be a nonnegative safe integer")
  }
  return selected
}

function toEntry(row: Row): DueSoonEntry {
  const direction = nullableText(row, "direction")
  if (direction !== null && direction !== "owed" && direction !== "waiting") {
    throw new Error("stored obligation direction is invalid")
  }
  const dueAt = requiredText(row, "due_at")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) {
    throw new Error("stored obligation due date is malformed")
  }
  return {
    id: positiveId(row),
    entity: {
      id: requiredText(row, "entity_id"),
      kind: entityKind(requiredText(row, "entity_kind")),
      name: requiredText(row, "entity_name"),
      tag: requiredText(row, "entity_tag"),
    },
    action: requiredText(row, "action"),
    party: nullableText(row, "party"),
    dueAt,
    direction,
    source: {
      documentId: requiredText(row, "doc_id"),
      span: sourceSpan(row),
    },
  }
}

/** Read open, dated obligations due within the next 90 local calendar dates, including overdue. */
export function listDueSoon(
  db: DatabaseSync,
  options: DueSoonOptions = {}
): DueSoonPage {
  const timezone = options.timezone ?? "Etc/UTC"
  const fromDate = calendarDate(options.now ?? new Date(), timezone)
  // Today is the first of the 90 included dates, so the final included date is today + 89.
  const throughDate = addCalendarDays(fromDate, DUE_SOON_DAYS - 1)
  // The query uses an exclusive bound. Add one day to include the throughDate.
  const exclusiveEnd = addCalendarDays(throughDate, 1)
  const limit = validPageSize(options.limit)
  const offset = validOffset(options.offset)
  const selected = db
    .prepare(
      `SELECT o.id, o.entity_id, e.kind AS entity_kind, e.name AS entity_name,
              e.tag AS entity_tag, o.party, o.action, o.due_at, o.direction,
              o.doc_id, o.source_span
       FROM obligations o JOIN entities e ON e.id = o.entity_id
       WHERE o.status = 'open' AND o.due_at IS NOT NULL AND o.due_at < ?
         AND (? IS NULL OR o.entity_id = ?)
       ORDER BY o.due_at, o.id LIMIT ? OFFSET ?`
    )
    .all(
      exclusiveEnd,
      options.entityId ?? null,
      options.entityId ?? null,
      limit + 1,
      offset
    )
  const hasNext = selected.length > limit
  const entries = selected.slice(0, limit).map((row) => toEntry(row))
  return {
    timezone,
    fromDate,
    throughDate,
    entries,
    nextOffset: hasNext ? offset + limit : null,
  }
}

type FieldError = { field: string; message: string }

export type DueSoonRouteResult =
  | { ok: true; body: DueSoonPage }
  | { ok: false; code: "invalid"; message: string; fields: FieldError[] }

const DIGITS = /^\d+$/

function param(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim()
  return value === undefined || value === "" ? undefined : value
}

function readCount(
  params: URLSearchParams,
  name: string,
  min: number,
  max: number,
  errors: FieldError[]
): number | undefined {
  const raw = param(params, name)
  if (raw === undefined) return undefined
  const value = DIGITS.test(raw) ? Number(raw) : NaN
  if (!(value >= min && value <= max)) {
    errors.push({
      field: name,
      message: `must be an integer from ${min} to ${max}`,
    })
    return undefined
  }
  return value
}

/** Serves `GET /today/due-soon?entity=&limit=&offset=` from the ledger, in the owner's timezone. */
export function dueSoonRoute(
  db: DatabaseSync,
  params: URLSearchParams,
  timezone: string | null,
  now: Date
): DueSoonRouteResult {
  const errors: FieldError[] = []
  const limit = readCount(params, "limit", 1, DUE_SOON_MAX_PAGE_SIZE, errors)
  const offset = readCount(params, "offset", 0, Number.MAX_SAFE_INTEGER, errors)
  if (errors.length > 0) {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: errors,
    }
  }
  const entityId = param(params, "entity")
  return {
    ok: true,
    body: listDueSoon(db, {
      now,
      timezone,
      ...(entityId === undefined ? {} : { entityId }),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    }),
  }
}
