import type { DatabaseSync } from "node:sqlite"
import type { SourceSpan } from "@eido/schemas"
import { writeQueueFor } from "../db/write-queue"
import { readLatestDigest } from "../digest/cache"
import { coverageLine, windowCoverage } from "./coverage"
import { addDays, daysBetween, localParts, parseTime } from "./local-time"
import { getBrief, insertBrief, latestWindowEnd } from "./store"
import type {
  Brief,
  BriefConfig,
  BriefItemLine,
  BriefLine,
  BriefSource,
} from "./types"

const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_TEXT = 140

type Row = Record<string, unknown>
type Pending = { lines: BriefItemLine[]; skipped: number }

function validate(cfg: BriefConfig): void {
  parseTime(cfg.time)
  if (!Number.isInteger(cfg.dueWithinDays) || cfg.dueWithinDays < 0)
    throw new RangeError("dueWithinDays must be a nonnegative integer")
  if (!Number.isInteger(cfg.maxLines) || cfg.maxLines < 1)
    throw new RangeError("maxLines must be a positive integer")
  if (!(cfg.confirmThreshold >= 0 && cfg.confirmThreshold <= 1))
    throw new RangeError("confirmThreshold must be between 0 and 1")
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

function spanOf(value: unknown): SourceSpan | undefined {
  if (!isRecord(value)) return undefined
  const { start, end, message_id: messageId, page } = value
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  )
    return undefined
  return {
    start,
    end,
    ...(typeof messageId === "string" ? { message_id: messageId } : {}),
    ...(typeof page === "number" ? { page } : {}),
  }
}

function parseSpan(json: unknown): SourceSpan | undefined {
  if (typeof json !== "string") return undefined
  try {
    return spanOf(JSON.parse(json))
  } catch {
    return undefined
  }
}

function sourceOf(docSha256: string, span: SourceSpan): BriefSource {
  return {
    docSha256,
    ...(span.message_id === undefined ? {} : { messageId: span.message_id }),
    ...(span.page === undefined ? {} : { page: span.page }),
    start: span.start,
    end: span.end,
  }
}

/** The first line of a cached digest of the document, else of its thread; none when not cached. */
function detailFor(
  db: DatabaseSync,
  docId: string,
  threadId: string | null
): BriefItemLine["detail"] {
  const stored =
    readLatestDigest(db, "document", docId) ??
    (threadId === null ? undefined : readLatestDigest(db, "thread", threadId))
  const first = stored?.lines[0]
  return first === undefined
    ? undefined
    : { text: first.text, cites: first.cites }
}

function obligationLines(
  db: DatabaseSync,
  rows: Row[],
  kind: "overdue" | "due" | "changed",
  today: string
): Pending {
  const lines: BriefItemLine[] = []
  let skipped = 0
  for (const row of rows) {
    const docId = String(row["doc_id"])
    const span = parseSpan(row["source_span"])
    if (span === undefined) {
      skipped += 1
      continue
    }
    const party = typeof row["party"] === "string" ? ` (${row["party"]})` : ""
    const action = `${clip(String(row["action"]))}${party}`
    const dueAt = typeof row["due_at"] === "string" ? row["due_at"] : undefined
    let text: string
    if (kind === "overdue" && dueAt !== undefined) {
      text = `${action}: ${plural(daysBetween(dueAt, today), "day", "days")} overdue`
    } else if (kind === "due" && dueAt !== undefined) {
      text =
        dueAt === today ? `${action}: due today` : `${action}: due ${dueAt}`
    } else {
      // Created in the window (its source document was ingested in it) reads as new; any other
      // change to an open obligation (reopened, due date moved) reads as updated.
      const created = row["created"] === 1
      text = `${created ? "New" : "Updated"}: ${action}${dueAt === undefined ? "" : `, due ${dueAt}`}`
    }
    const threadId =
      typeof row["thread_id"] === "string" ? row["thread_id"] : null
    const detail = detailFor(db, docId, threadId)
    lines.push({
      text,
      kind,
      ledger: { type: "obligation", id: String(row["id"]) },
      source: sourceOf(docId, span),
      ...(detail === undefined ? {} : { detail }),
    })
  }
  return { lines, skipped }
}

const OBLIGATION_COLUMNS = `o.id, o.party, o.action, o.due_at, o.doc_id, o.source_span, o.thread_id`

function selectObligations(
  db: DatabaseSync,
  today: string,
  horizon: string,
  windowStart: string,
  windowEnd: string
): Pending {
  const overdue = db
    .prepare(
      `SELECT ${OBLIGATION_COLUMNS} FROM obligations o
       WHERE o.status = 'open' AND o.due_at < ? ORDER BY o.due_at, o.id`
    )
    .all(today)
  const due = db
    .prepare(
      `SELECT ${OBLIGATION_COLUMNS} FROM obligations o
       WHERE o.status = 'open' AND o.due_at >= ? AND o.due_at <= ?
       ORDER BY o.due_at, o.id`
    )
    .all(today, horizon)
  // Changed in the window: the obligation's change time (#481) is in it, set on creation and on a
  // status or due-date change. Re-ingesting its source does not move it. Obligations already
  // listed as overdue or due are not repeated.
  const changed = db
    .prepare(
      `SELECT ${OBLIGATION_COLUMNS},
         (d.ingested_at > ? AND d.ingested_at <= ?) AS created
       FROM obligations o
       JOIN documents d ON d.sha256 = o.doc_id
       WHERE o.status = 'open' AND (o.due_at IS NULL OR o.due_at > ?)
         AND o.updated_at > ? AND o.updated_at <= ?
       ORDER BY o.updated_at, o.id`
    )
    .all(windowStart, windowEnd, horizon, windowStart, windowEnd)
  const parts = [
    obligationLines(db, overdue, "overdue", today),
    obligationLines(db, due, "due", today),
    obligationLines(db, changed, "changed", today),
  ]
  return {
    lines: parts.flatMap((part) => part.lines),
    skipped: parts.reduce((sum, part) => sum + part.skipped, 0),
  }
}

/** Unconfirmed extractions with a field below the threshold, lowest confidence first per row. */
function selectNeedsYou(db: DatabaseSync, threshold: number): Pending {
  const rows = db
    .prepare(
      `SELECT e.id, e.doc_id, e.fields_json, c.field
       FROM extractions e
       JOIN extraction_field_confidence c ON c.extraction_id = e.id
       WHERE e.status = 'extracted' AND e.confirmed_at IS NULL AND c.confidence < ?
       ORDER BY e.id, c.confidence, c.field`
    )
    .all(threshold)
  const lines: BriefItemLine[] = []
  let skipped = 0
  const seen = new Set<string>()
  for (const row of rows) {
    const id = String(row["id"])
    if (seen.has(id)) continue
    seen.add(id)
    const field = String(row["field"])
    const fields: unknown = JSON.parse(String(row["fields_json"]))
    const entry = isRecord(fields) ? fields[field] : undefined
    const raw = isRecord(entry) ? entry["raw"] : undefined
    const span = isRecord(entry) ? spanOf(entry["span"]) : undefined
    if (span === undefined || typeof raw !== "string") {
      skipped += 1
      continue
    }
    lines.push({
      text: `Confirm ${field.replace(/_/g, " ")}: "${clip(raw)}"`,
      kind: "needs-you",
      ledger: { type: "extraction", id },
      source: sourceOf(String(row["doc_id"]), span),
    })
  }
  return { lines, skipped }
}

function capLines(items: BriefItemLine[], maxLines: number): BriefLine[] {
  if (items.length <= maxLines) return items
  const kept = items.slice(0, maxLines - 1)
  const collapsed = items.slice(maxLines - 1)
  const allDue = collapsed.every(
    (item) => item.kind === "overdue" || item.kind === "due"
  )
  return [
    ...kept,
    {
      text: `${collapsed.length} more${allDue ? " due soon" : ""}`,
      kind: "more",
      count: collapsed.length,
      ledger: { type: "ledger" },
    },
  ]
}

function build(db: DatabaseSync, now: Date, cfg: BriefConfig): Brief {
  const { date: forDate } = localParts(now, cfg.timezone)
  const stored = getBrief(db, forDate)
  if (stored !== undefined) return stored
  const windowEnd = now.toISOString()
  const previousEnd = latestWindowEnd(db)
  const windowStart =
    previousEnd !== undefined && previousEnd <= windowEnd
      ? previousEnd
      : new Date(now.getTime() - FIRST_WINDOW_MS).toISOString()
  const horizon = addDays(forDate, cfg.dueWithinDays)
  const obligations = selectObligations(
    db,
    forDate,
    horizon,
    windowStart,
    windowEnd
  )
  const needsYou = selectNeedsYou(db, cfg.confirmThreshold)
  const lines = capLines(
    [...obligations.lines, ...needsYou.lines],
    cfg.maxLines
  )
  const coverage = {
    ...windowCoverage(db, windowStart, windowEnd),
    skipped: obligations.skipped + needsYou.skipped,
  }
  const brief: Brief = {
    id: `brief-${forDate}`,
    forDate,
    generatedAt: windowEnd,
    windowStart,
    windowEnd,
    lines,
    coverage,
    coverageLine: coverageLine(coverage, lines.length > 0),
  }
  insertBrief(db, brief)
  return brief
}

/**
 * Builds and stores the brief for the local date of `now`, or returns the one already stored for
 * that date. Reads the ledger only: no model call, no network. Runs on the connection's write
 * queue, so a crash leaves either the whole row or none.
 */
export async function generateBrief(
  db: DatabaseSync,
  now: Date,
  cfg: BriefConfig
): Promise<Brief> {
  validate(cfg)
  return await writeQueueFor(db).run(() => build(db, now, cfg))
}
