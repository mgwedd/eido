export type LedgerErrorCode =
  | "default_entity_required"
  | "newer_schema"
  | "document_not_found"
  | "entity_not_found"
  | "extraction_not_found"
  | "already_confirmed"
  | "entity_mismatch"
  | "invalid_span"
  | "invalid_confidence"
  | "invalid_injection_provenance"
  | "obligation_not_found"
  | "invalid_transition"
  | "busy"

/** Typed failure of a ledger call. Messages never contain document text or stored values. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode

  constructor(code: LedgerErrorCode, message: string) {
    super(message)
    this.name = "LedgerError"
    this.code = code
  }
}
