// Extraction pipeline (#46): prefilter, model call, verbatim verification, ledger writes.
export {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_EXTRACTION_REPLY_TOKENS,
  DEFAULT_TOKEN_BUDGET,
  EXTRACTION_SCHEMA,
  ExtractionError,
  createExtractor,
} from "./pipeline"
export type {
  ExtractOptions,
  ExtractionConfig,
  ExtractionErrorCode,
  Extractor,
  ExtractorDeps,
} from "./pipeline"
export {
  DEFAULT_MAX_PASSAGES,
  DEFAULT_PHRASES,
  DEFAULT_WINDOW_CHARS,
  selectCandidatePassages,
} from "./prefilter"
export type { PrefilterOptions, PrefilterResult } from "./prefilter"
export { defaultFieldConfidence } from "./verify"
export type {
  ConfirmCandidate,
  ExtractionLogEvent,
  ExtractionResult,
  ExtractionStatus,
  FieldConfidenceInput,
  FieldScorer,
  Passage,
  ReplyCheck,
} from "./types"
