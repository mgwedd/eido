import type { SourceSpan } from "@eido/schemas"
import type { InjectionReason } from "../inference/fence"
import type { ExtractionFieldName } from "../ledger/types"

export type ExtractionStatus =
  | "ok"
  | "no_candidates"
  | "already_processed"
  | "model_output_rejected"
  | "refused_over_budget"

/** A field the ledger does not accept on its own: a human confirms it first (#47). */
export type ConfirmCandidate = {
  docId: string
  /** The `extractions` row holding the field; it stays unconfirmed until #47 confirms it. */
  extractionId: number
  field: ExtractionFieldName
  /** The verbatim quote from normalized parsed text; `span` points into the original parsed text. */
  raw: string
  /** The typed value (amount, ISO date), the quote for a text field, or null when parsing failed. */
  parsed: unknown
  reason: "parse_failed" | "low_confidence"
  confidence: number
  threshold: number
  span: SourceSpan
  /** True when fence flagged the passage the quote came from; the card can warn on it. */
  injectionSuspected: boolean
  injectionReasons: InjectionReason[]
}

/**
 * What one run reports, to callers and to the planner. It holds counts, extracted quotes and
 * spans only: no passage text, since the planner sees untrusted bodies only as extracted fields.
 */
export type ExtractionResult = {
  docId: string
  status: ExtractionStatus
  proposed: number
  verified: number
  needsConfirmation: number
  dropped: number
  passagesRead: number
  passagesTotal: number
  summary: string
  confirmations: ConfirmCandidate[]
  obligationIds: number[]
  /** What fence found in the passages sent to the model, in a fixed order; empty when clean. */
  injectionReasons: InjectionReason[]
}

/** A window of the normalized parsed text, `[start, end)` in UTF-16 code units. */
export type Passage = { start: number; end: number; text: string }

/** What a field's confidence is computed from. `parsed` is false for a quote that did not parse. */
export type FieldConfidenceInput = {
  field: ExtractionFieldName
  quote: string
  parsed: boolean
}

/** Returns a confidence between 0 and 1 for one field. */
export type FieldScorer = (input: FieldConfidenceInput) => number

/** Logged events carry no document or model text. */
export type ExtractionLogEvent =
  | {
      event: "reply_failed_check"
      docId: string
      attempt: 1 | 2
      check: ReplyCheck
    }
  | { event: "passage_skipped_over_budget"; docId: string; passage: number }

/** The checks a model reply must pass before its items are verified. */
export type ReplyCheck =
  | "prompt_truncated"
  | "reply_cut_off"
  | "not_json"
  | "schema"
  | "inconsistent_nothing_found"
  | "over_budget"
