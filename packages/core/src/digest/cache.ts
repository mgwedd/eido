import { INJECTION_REASONS } from "../inference/index"
import type { DatabaseSync } from "node:sqlite"
import type { Cite, Digest, DigestCoverage, DigestLine } from "./types"

/**
 * The digests table of eido-data.db. The service applies it itself on creation; it is
 * idempotent (CREATE ... IF NOT EXISTS). Rows are never deleted: after a rebuild the old
 * digest stays readable under its old key.
 */
export const DIGEST_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS digests (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('thread','document')),
  subject_ref TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS digests_subject ON digests(kind, subject_ref, created_at);
`

export function applyDigestMigration(db: DatabaseSync): void {
  db.exec(DIGEST_MIGRATION_SQL)
}

export interface StoredDigest {
  key: string
  kind: "thread" | "document"
  subjectRef: string
  promptVersion: string
  modelId: string
  fingerprint: string
  lines: DigestLine[]
  coverage: DigestCoverage
  createdAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCite(value: unknown): value is Cite {
  if (!isRecord(value)) return false
  const { injectionSuspected, reasons } = value
  if (
    typeof injectionSuspected !== "boolean" ||
    !Array.isArray(reasons) ||
    !reasons.every((reason: unknown) =>
      INJECTION_REASONS.some((known) => known === reason)
    ) ||
    injectionSuspected !== reasons.length > 0
  )
    return false
  if (typeof value["messageId"] === "string") return true
  return (
    typeof value["docSha256"] === "string" &&
    typeof value["page"] === "number" &&
    Number.isInteger(value["page"])
  )
}

function parseLines(json: string): DigestLine[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const lines: DigestLine[] = []
  for (const entry of parsed as unknown[]) {
    if (!isRecord(entry)) return undefined
    const { text, cites } = entry
    if (typeof text !== "string" || !Array.isArray(cites) || cites.length < 1) {
      return undefined
    }
    if (!(cites as unknown[]).every(isCite)) return undefined
    lines.push({ text, cites: cites as Cite[] })
  }
  return lines
}

function parseCoverage(json: string): DigestCoverage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const { sections, linesKept, linesDropped, splitSegments } = parsed
  if (
    typeof sections !== "number" ||
    typeof linesKept !== "number" ||
    typeof linesDropped !== "number" ||
    typeof splitSegments !== "number"
  ) {
    return undefined
  }
  return { sections, linesKept, linesDropped, splitSegments }
}

function toStored(row: Record<string, unknown>): StoredDigest | undefined {
  const lines = parseLines(String(row["lines_json"]))
  const coverage = parseCoverage(String(row["coverage_json"]))
  if (lines === undefined || coverage === undefined) return undefined
  return {
    key: String(row["key"]),
    kind: row["kind"] === "document" ? "document" : "thread",
    subjectRef: String(row["subject_ref"]),
    promptVersion: String(row["prompt_version"]),
    modelId: String(row["model_id"]),
    fingerprint: String(row["fingerprint"]),
    lines,
    coverage,
    createdAt: String(row["created_at"]),
  }
}

/** The digest stored under `key`. A row that no longer parses counts as a miss. */
export function readDigest(db: DatabaseSync, key: string): Digest | undefined {
  const row = db.prepare("SELECT * FROM digests WHERE key = ?").get(key)
  const stored = row === undefined ? undefined : toStored(row)
  return stored === undefined
    ? undefined
    : { key: stored.key, lines: stored.lines, coverage: stored.coverage }
}

/** The newest stored digest of a subject, whatever its prompt version, model or fingerprint. */
export function readLatestDigest(
  db: DatabaseSync,
  kind: "thread" | "document",
  subjectRef: string
): StoredDigest | undefined {
  const rows = db
    .prepare(
      "SELECT * FROM digests WHERE kind = ? AND subject_ref = ? ORDER BY created_at DESC, rowid DESC"
    )
    .all(kind, subjectRef)
  for (const row of rows) {
    const stored = toStored(row)
    if (stored !== undefined) return stored
  }
  return undefined
}

export function writeDigest(db: DatabaseSync, row: StoredDigest): void {
  db.prepare(
    `INSERT OR REPLACE INTO digests
       (key, kind, subject_ref, prompt_version, model_id, fingerprint, lines_json, coverage_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.key,
    row.kind,
    row.subjectRef,
    row.promptVersion,
    row.modelId,
    row.fingerprint,
    JSON.stringify(row.lines),
    JSON.stringify(row.coverage),
    row.createdAt
  )
}
