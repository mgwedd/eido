import { extname, isAbsolute, normalize, sep } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { validateExtractedFields } from "@eido/schemas"
import { ingestBatch } from "../index/ingest"
import type { ExtractionFieldName } from "../ledger/types"
import type { Parser } from "../parsers/parse-document"
import { createExtractor } from "./pipeline"
import type { ExtractorDeps } from "./pipeline"
import type { ExtractionStatus } from "./types"

// The accuracy run (issue #46): the owner's documents and a labels file, both outside the repo,
// scored with strict exact matching. Nothing here ships documents, labels or results anywhere;
// the report is counts and ratios only.

export const ACCURACY_FIELDS = [
  "action",
  "party",
  "due_date",
  "amount",
  "reference_number",
] as const satisfies readonly ExtractionFieldName[]

/** One expected obligation; each value is the text exactly as it appears in the document. */
export type ExpectedItem = { action: string } & Partial<
  Record<Exclude<ExtractionFieldName, "action">, string>
>

export type AccuracyLabel = { file: string; expected: ExpectedItem[] }

/** Raw quotes of one stored extraction, by field. */
export type ExtractedItem = Partial<Record<ExtractionFieldName, string>>

/**
 * Checks the labels file: `[{ file, expected: [{ action, party?, due_date?, amount?,
 * reference_number? }] }]`. `file` is relative to the documents directory and may not leave it.
 */
export function parseLabels(value: unknown): AccuracyLabel[] {
  if (!Array.isArray(value)) throw new Error("labels must be an array")
  return value.map((entry: unknown, i): AccuracyLabel => {
    const at = `labels[${String(i)}]`
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${at} must be an object`)
    }
    const file: unknown = Reflect.get(entry, "file")
    const expected: unknown = Reflect.get(entry, "expected")
    for (const key of Object.keys(entry)) {
      if (key !== "file" && key !== "expected") {
        throw new Error(`${at} has an unknown key ${key}`)
      }
    }
    if (typeof file !== "string" || !insideDirectory(file)) {
      throw new Error(
        `${at}.file must be a relative path inside the documents directory`
      )
    }
    if (!Array.isArray(expected))
      throw new Error(`${at}.expected must be an array`)
    return {
      file,
      expected: expected.map((item: unknown, j) =>
        expectedItem(item, `${at}.expected[${String(j)}]`)
      ),
    }
  })
}

function insideDirectory(file: string): boolean {
  if (file === "" || isAbsolute(file)) return false
  const normal = normalize(file)
  return normal !== ".." && !normal.startsWith(`..${sep}`)
}

function expectedItem(value: unknown, at: string): ExpectedItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${at} must be an object`)
  }
  const fields: Partial<Record<ExtractionFieldName, string>> = {}
  for (const key of Object.keys(value)) {
    const field = ACCURACY_FIELDS.find((name) => name === key)
    if (field === undefined) throw new Error(`${at} has an unknown key ${key}`)
    const raw: unknown = Reflect.get(value, key)
    if (typeof raw !== "string")
      throw new Error(`${at}.${key} must be a string`)
    fields[field] = raw
  }
  const { action } = fields
  if (action === undefined) throw new Error(`${at}.action is required`)
  return { ...fields, action }
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".eml": "message/rfc822",
  ".mbox": "application/mbox",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
}

/** The declared type for a file the parser reads, by extension; null for anything else. */
export function mimeFor(file: string): string | null {
  return MIME_BY_EXTENSION[extname(file).toLowerCase()] ?? null
}

/** Raw quotes of every `extracted` row stored for a document, verified or awaiting confirmation. */
export function readExtractedItems(
  db: DatabaseSync,
  docId: string
): ExtractedItem[] {
  const rows = db
    .prepare(
      "SELECT fields_json FROM extractions WHERE doc_id = ? AND status = 'extracted' ORDER BY id"
    )
    .all(docId)
  return rows.map((row) => {
    const validated = validateExtractedFields(
      JSON.parse(String(row["fields_json"]))
    )
    if (!validated.ok)
      throw new Error("a stored extraction does not match its schema")
    const item: ExtractedItem = {}
    for (const field of ACCURACY_FIELDS) {
      const value = validated.value[field]
      if (value !== undefined) item[field] = value.raw
    }
    return item
  })
}

export type DocumentOutcome =
  | { file: string; kind: "skipped"; reason: "unsupported_type" }
  | { file: string; kind: "failed"; reason: string }
  | {
      file: string
      kind: "extracted"
      status: ExtractionStatus
      proposed: number
      verified: number
      needsConfirmation: number
      expected: ExpectedItem[]
      extracted: ExtractedItem[]
    }

export type FieldScore = {
  expected: number
  extracted: number
  matched: number
  /** matched / extracted; null when nothing was extracted. */
  precision: number | null
  /** matched / expected; null when nothing was expected. */
  recall: number | null
}

export type AccuracyReport = {
  documents: number
  skipped: number
  failed: number
  statuses: Partial<Record<ExtractionStatus, number>>
  fields: Record<ExtractionFieldName, FieldScore>
  proposed: number
  verified: number
  /** verified / proposed; null when nothing was proposed. */
  verifiedRate: number | null
  /** Items held back for confirmation. */
  sentToConfirmation: number
}

/** Exact matches between two lists of strings, each value counted as often as it appears in both. */
function matches(expected: string[], extracted: string[]): number {
  const left = new Map<string, number>()
  for (const value of expected) left.set(value, (left.get(value) ?? 0) + 1)
  let matched = 0
  for (const value of extracted) {
    const count = left.get(value) ?? 0
    if (count > 0) {
      matched += 1
      left.set(value, count - 1)
    }
  }
  return matched
}

const ratio = (part: number, whole: number): number | null =>
  whole === 0 ? null : part / whole

type Counts = { expected: number; extracted: number; matched: number }

const zero = (): Counts => ({ expected: 0, extracted: 0, matched: 0 })

const score = (counts: Counts): FieldScore => ({
  ...counts,
  precision: ratio(counts.matched, counts.extracted),
  recall: ratio(counts.matched, counts.expected),
})

/** Per-field precision and recall by strict exact match, per document, summed over documents. */
export function scoreAccuracy(
  outcomes: readonly DocumentOutcome[]
): AccuracyReport {
  const totals: Record<ExtractionFieldName, Counts> = {
    action: zero(),
    party: zero(),
    due_date: zero(),
    amount: zero(),
    reference_number: zero(),
  }
  let skipped = 0
  let failed = 0
  let proposed = 0
  let verified = 0
  let sentToConfirmation = 0
  const statuses: Partial<Record<ExtractionStatus, number>> = {}
  for (const outcome of outcomes) {
    if (outcome.kind === "skipped") {
      skipped += 1
      continue
    }
    if (outcome.kind === "failed") {
      failed += 1
      continue
    }
    statuses[outcome.status] = (statuses[outcome.status] ?? 0) + 1
    proposed += outcome.proposed
    verified += outcome.verified
    sentToConfirmation += outcome.needsConfirmation
    for (const field of ACCURACY_FIELDS) {
      const expected = outcome.expected.flatMap((item) => item[field] ?? [])
      const extracted = outcome.extracted.flatMap((item) => item[field] ?? [])
      totals[field].expected += expected.length
      totals[field].extracted += extracted.length
      totals[field].matched += matches(expected, extracted)
    }
  }
  return {
    documents: outcomes.length,
    skipped,
    failed,
    statuses,
    fields: {
      action: score(totals.action),
      party: score(totals.party),
      due_date: score(totals.due_date),
      amount: score(totals.amount),
      reference_number: score(totals.reference_number),
    },
    proposed,
    verified,
    verifiedRate: ratio(verified, proposed),
    sentToConfirmation,
  }
}

const percent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`

/** The report as plain text, for the PR description. Counts and ratios only, no document text. */
export function formatReport(report: AccuracyReport): string {
  const statuses = Object.entries(report.statuses)
    .map(([status, count]) => `${status} ${String(count)}`)
    .join(", ")
  const lines = [
    `documents: ${String(report.documents)} (skipped ${String(report.skipped)}, failed ${String(report.failed)})`,
    `statuses: ${statuses === "" ? "none" : statuses}`,
    "field             precision  recall  matched/extracted/expected",
    ...ACCURACY_FIELDS.map((field) => {
      const s = report.fields[field]
      return `${field.padEnd(18)}${percent(s.precision).padEnd(11)}${percent(s.recall).padEnd(8)}${String(s.matched)}/${String(s.extracted)}/${String(s.expected)}`
    }),
    `verified rate: ${percent(report.verifiedRate)} (${String(report.verified)} of ${String(report.proposed)} proposed)`,
    `sent to confirmation: ${String(report.sentToConfirmation)}`,
  ]
  return lines.join("\n")
}

export type AccuracyDeps = ExtractorDeps & {
  /** Parses each original once; its text is stored as the document body the extractor reads. */
  parser: Pick<Parser, "parseDocument" | "storeOriginal">
  /** The entity the documents are filed under. */
  entityId: string
  /** Reads one labelled file's bytes. */
  readFile: (file: string) => Uint8Array
}

/** Stores, extracts and scores each labelled document in order. */
export async function runAccuracy(
  labels: readonly AccuracyLabel[],
  deps: AccuracyDeps
): Promise<{ outcomes: DocumentOutcome[]; report: AccuracyReport }> {
  const extractor = createExtractor(deps)
  const outcomes: DocumentOutcome[] = []
  const seen = new Map<string, string>()
  for (const [index, label] of labels.entries()) {
    const mime = mimeFor(label.file)
    if (mime === null) {
      outcomes.push({
        file: label.file,
        kind: "skipped",
        reason: "unsupported_type",
      })
      continue
    }
    const { sha256 } = deps.parser.storeOriginal(deps.readFile(label.file))
    const first = seen.get(sha256)
    if (first !== undefined) {
      // A second run would store a second set of rows for the same document and count them twice.
      outcomes.push({
        file: label.file,
        kind: "failed",
        reason: `same bytes as ${first}`,
      })
      continue
    }
    seen.set(sha256, label.file)
    const parsed = await deps.parser.parseDocument({ blobSha256: sha256, mime })
    if (!parsed.ok) {
      outcomes.push({
        file: label.file,
        kind: "failed",
        reason: `the document could not be parsed (${parsed.reason})`,
      })
      continue
    }
    ingestBatch(deps.db, {
      connector: "accuracy",
      stream: "local",
      documents: [
        {
          sha256,
          source: "local",
          sourceRef: label.file,
          mime,
          entityId: deps.entityId,
          body: parsed.text,
        },
      ],
      nextCursor: String(index),
    })
    try {
      const result = await extractor.extractDocument(sha256)
      outcomes.push({
        file: label.file,
        kind: "extracted",
        status: result.status,
        proposed: result.proposed,
        verified: result.verified,
        needsConfirmation: result.needsConfirmation,
        expected: label.expected,
        extracted: readExtractedItems(deps.db, sha256),
      })
    } catch (error) {
      outcomes.push({
        file: label.file,
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { outcomes, report: scoreAccuracy(outcomes) }
}
