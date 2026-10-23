import {
  parseAmountField,
  parseDueDateField,
  validateExtractedFields,
} from "@eido/schemas"
import type {
  ExtractedFields,
  ExtractionCandidates,
  SourceSpan,
} from "@eido/schemas"
import type { ExtractionFieldName } from "../ledger/types"
import { lookupOffset } from "../parsers/offsets"
import type { OffsetTable } from "../parsers/types"
import type { FieldScorer, Passage } from "./types"

export type CandidateItem = ExtractionCandidates["items"][number]

/** A field that needs a human before the ledger takes it. */
export type FlaggedField = {
  field: ExtractionFieldName
  raw: string
  parsed: unknown
  reason: "parse_failed" | "low_confidence"
  confidence: number
  span: SourceSpan
}

export type ItemOutcome =
  | { kind: "dropped" }
  | {
      kind: "verified" | "needs_confirmation"
      fields: ExtractedFields
      confidence: Partial<Record<ExtractionFieldName, number>>
      /** Empty for a verified item. */
      flagged: FlaggedField[]
    }

const FIELD_ORDER = [
  "action",
  "party",
  "reference_number",
  "amount",
  "due_date",
] as const satisfies readonly ExtractionFieldName[]

/** Default confidence: 1.0 for a field whose quote verified and parsed, 0 for one that did not parse. */
export const defaultFieldConfidence: FieldScorer = ({ parsed }) =>
  parsed ? 1 : 0

/**
 * Where `quote` is in `text`, by exact `indexOf`: no trimming, case folding or Unicode
 * normalization. An occurrence inside `passage` wins over an earlier one elsewhere. -1 when absent.
 */
export function locateQuote(
  text: string,
  quote: string,
  passage: Passage
): number {
  const inPassage = text.indexOf(quote, passage.start)
  if (inPassage !== -1 && inPassage + quote.length <= passage.end) {
    return inPassage
  }
  return text.indexOf(quote)
}

/** `[start, end)` with the message, page and line of `start` from the parser's offset table. */
export function spanAt(
  offsets: OffsetTable,
  start: number,
  end: number
): SourceSpan {
  const span: SourceSpan = { start, end }
  const entry = lookupOffset(offsets, start)
  if (entry === null) return span
  if (entry.messageId !== undefined) span.message_id = entry.messageId
  if (entry.page !== undefined) span.page = entry.page
  span.line = entry.line
  return span
}

/**
 * Verifies one schema-valid item, in order: every quote is found verbatim (else the item is
 * dropped), each start is mapped to a span, money and date quotes are parsed, and each field's
 * confidence is compared with `threshold` on its own.
 */
export function verifyItem(
  item: CandidateItem,
  passage: Passage,
  source: { text: string; offsets: OffsetTable },
  threshold: number,
  scorer: FieldScorer
): ItemOutcome {
  const spans: Partial<Record<ExtractionFieldName, SourceSpan>> = {}
  for (const field of FIELD_ORDER) {
    const quote = item[field]?.quote
    if (quote === undefined) continue
    const start = locateQuote(source.text, quote, passage)
    if (start === -1) return { kind: "dropped" }
    spans[field] = spanAt(source.offsets, start, start + quote.length)
  }

  const fields: Record<string, unknown> = {}
  for (const field of FIELD_ORDER) {
    const quote = item[field]?.quote
    const span = spans[field]
    if (quote === undefined || span === undefined) continue
    fields[field] =
      field === "amount"
        ? parseAmountField(quote, span)
        : field === "due_date"
          ? parseDueDateField(quote, span)
          : { raw: quote, span }
  }
  // A quote can pass the candidate schema and still break the stored one (a reference number
  // longer than 64 characters); such an item is dropped, not stored.
  const validated = validateExtractedFields(fields)
  if (!validated.ok) return { kind: "dropped" }
  const extracted = validated.value

  const confidence: Partial<Record<ExtractionFieldName, number>> = {}
  const flagged: FlaggedField[] = []
  for (const field of FIELD_ORDER) {
    const value = extracted[field]
    if (value === undefined) continue
    const typed =
      "status" in value
        ? value.status === "parsed"
          ? value.value
          : null
        : value.raw
    const parsed = typed !== null
    const score = scorer({ field, quote: value.raw, parsed })
    if (!(score >= 0 && score <= 1)) {
      throw new RangeError(`confidence for ${field} must be between 0 and 1`)
    }
    confidence[field] = score
    const reason = !parsed
      ? "parse_failed"
      : score < threshold
        ? "low_confidence"
        : null
    if (reason !== null) {
      flagged.push({
        field,
        raw: value.raw,
        parsed: typed,
        reason,
        confidence: score,
        span: value.span,
      })
    }
  }
  return {
    kind: flagged.length === 0 ? "verified" : "needs_confirmation",
    fields: extracted,
    confidence,
    flagged,
  }
}
