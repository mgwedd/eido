// JSON Schema source of truth for intents and extractions; types, validators and the
// prompt and grammar constants are generated from it.
export const SCHEMA_VERSION = 0

export * from "./generated/types"
export {
  INTENT_KINDS,
  INTENT_PROMPT_TEXT,
  INTENT_RESULT_JSON_SCHEMA,
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
  validateProfileAccountAssignment,
  validateProfileEntityInput,
  validateProfileEntityPatch,
  validateProfileUpdate,
} from "./generated/validators"
export { validateConnectorManifest } from "./manifest"
export type { JsonSchema, ValidationResult } from "./validate"
