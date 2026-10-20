// JSON Schema source of truth for intents and extractions; types, validators and the
// prompt and grammar constants are generated from it.
export const SCHEMA_VERSION = 0

export * from "./generated/types"
export {
  INTENT_KINDS,
  INTENT_PROMPT_TEXT,
  INTENT_RESULT_JSON_SCHEMA,
  extractionCandidatesJsonSchema,
} from "./generated/prompt"
export {
  INTENT_JSON_SCHEMA,
  validateGateApiError,
  validateGateAuditChainStatus,
  validateGateAuditPage,
  validateGateAuditPageRequest,
  validateGateAuditRecordRequest,
  validateGateAuditRecordResult,
  validateGateConnectorHealth,
  validateGateCredentialStatus,
  validateGateDecisionRequest,
  validateGateDecisionResult,
  validateGateEditRequest,
  validateGateIntentHistory,
  validateGateIntentProposal,
  validateGateIntentStatus,
  validateGateLoginOptions,
  validateGateLoginRequest,
  validateGateMailFolderList,
  validateGateMailFolderState,
  validateGateMailMessagePage,
  validateGatePendingIntentList,
  validateGatePrepareApproval,
  validateGateProposeRefusal,
  validateGateProposeResult,
  validateGateRejectReason,
  validateGateSession,
  validateGateWebAuthnAssertion,
  validateIntent,
  validateIntentResult,
  validateExtractionCandidates,
  validateProfileAccountAssignment,
  validateProfileEntityInput,
  validateProfileEntityPatch,
  validateProfileUpdate,
} from "./generated/validators"
export { validateConnectorManifest } from "./manifest"
export {
  parseMoney,
  parseDate,
  parseAmountField,
  parseDueDateField,
} from "./extraction/parse"
export type { ParsedMoney, ParsedDate } from "./extraction/parse"
export { validateExtractedFields } from "./extraction/validate"
export type { JsonSchema, ValidationResult } from "./validate"
