import type { DatabaseSync } from "node:sqlite"
import { coverageLine } from "./coverage"
import type {
  Brief,
  BriefCoverage,
  BriefDeferredLine,
  BriefItemLine,
  BriefLine,
  BriefMoreLine,
} from "./types"

type Row = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function isSource(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value["docSha256"] === "string" &&
    Number.isInteger(value["start"]) &&
    Number.isInteger(value["end"]) &&
    (value["messageId"] === undefined ||
      typeof value["messageId"] === "string") &&
    (value["page"] === undefined || typeof value["page"] === "number")
  )
}

function isLedger(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    (value["type"] === "obligation" || value["type"] === "extraction")
  )
}

function isItemLine(value: Record<string, unknown>): value is BriefItemLine {
  const detail = value["detail"]
  return (
    typeof value["text"] === "string" &&
    (value["kind"] === "overdue" ||
      value["kind"] === "due" ||
      value["kind"] === "changed" ||
      value["kind"] === "needs-you") &&
    isLedger(value["ledger"]) &&
    isSource(value["source"]) &&
    (detail === undefined ||
      (isRecord(detail) &&
        typeof detail["text"] === "string" &&
        Array.isArray(detail["cites"])))
  )
}

function isMoreLine(value: Record<string, unknown>): value is BriefMoreLine {
  const ledger = value["ledger"]
  return (
    typeof value["text"] === "string" &&
    value["kind"] === "more" &&
    typeof value["count"] === "number" &&
    isRecord(ledger) &&
    ledger["type"] === "ledger"
  )
}

function isDeferredLine(
  value: Record<string, unknown>
): value is BriefDeferredLine {
  return (
    typeof value["text"] === "string" &&
    value["kind"] === "deferred" &&
    isLedger(value["ledger"])
  )
}

function parseLines(json: string): BriefLine[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed))
    throw new Error("stored brief lines are malformed")
  return parsed.map((entry: unknown): BriefLine => {
    if (isRecord(entry) && isItemLine(entry)) return entry
    if (isRecord(entry) && isMoreLine(entry)) return entry
    if (isRecord(entry) && isDeferredLine(entry)) return entry
    throw new Error("stored brief line is malformed")
  })
}

const COVERAGE_COUNTS = [
  "messagesRead",
  "messagesTotal",
  "documentsRead",
  "documentsTotal",
  "skipped",
] as const

function parseCoverage(json: string): BriefCoverage {
  const parsed: unknown = JSON.parse(json)
  if (
    !isRecord(parsed) ||
    typeof parsed["windowStart"] !== "string" ||
    typeof parsed["windowEnd"] !== "string"
  )
    throw new Error("stored brief coverage is malformed")
  const counts = COVERAGE_COUNTS.map((key) => parsed[key])
  const [messagesRead, messagesTotal, documentsRead, documentsTotal, skipped] =
    counts
  if (
    typeof messagesRead !== "number" ||
    typeof messagesTotal !== "number" ||
    typeof documentsRead !== "number" ||
    typeof documentsTotal !== "number" ||
    typeof skipped !== "number"
  )
    throw new Error("stored brief coverage is malformed")
  return {
    messagesRead,
    messagesTotal,
    documentsRead,
    documentsTotal,
    windowStart: parsed["windowStart"],
    windowEnd: parsed["windowEnd"],
    skipped,
  }
}

function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== "string") throw new Error(`stored ${key} is not text`)
  return value
}

function toBrief(row: Row): Brief {
  const lines = parseLines(text(row, "lines_json"))
  const coverage = parseCoverage(text(row, "coverage_json"))
  return {
    id: text(row, "id"),
    forDate: text(row, "for_date"),
    generatedAt: text(row, "generated_at"),
    windowStart: text(row, "window_start"),
    windowEnd: text(row, "window_end"),
    lines,
    coverage,
    coverageLine: coverageLine(coverage, lines.length > 0),
  }
}

/** The brief stored for a local date, or undefined. */
export function getBrief(db: DatabaseSync, forDate: string): Brief | undefined {
  const row = db.prepare("SELECT * FROM briefs WHERE for_date = ?").get(forDate)
  return row === undefined ? undefined : toBrief(row)
}

/** The brief of the newest local date, or undefined when none was generated. */
export function getLatestBrief(db: DatabaseSync): Brief | undefined {
  const row = db
    .prepare("SELECT * FROM briefs ORDER BY for_date DESC LIMIT 1")
    .get()
  return row === undefined ? undefined : toBrief(row)
}

/** The end of the newest stored window, or undefined on the first run. */
export function latestWindowEnd(db: DatabaseSync): string | undefined {
  const row = db
    .prepare("SELECT window_end FROM briefs ORDER BY for_date DESC LIMIT 1")
    .get()
  return row === undefined ? undefined : text(row, "window_end")
}

export function insertBrief(db: DatabaseSync, brief: Brief): void {
  db.prepare(
    `INSERT INTO briefs (id, for_date, generated_at, window_start, window_end, lines_json, coverage_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    brief.id,
    brief.forDate,
    brief.generatedAt,
    brief.windowStart,
    brief.windowEnd,
    JSON.stringify(brief.lines),
    JSON.stringify(brief.coverage)
  )
}
