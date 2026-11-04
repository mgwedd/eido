export { proposeIntents } from "./propose"
export type {
  ProposalRequest,
  ProposalResult,
  ProposeConfig,
  ProposeDeps,
  ProposedIntent,
} from "./propose"
export { createProposalLimiter } from "./limiter"
export type { ProposalLimiter, ProposalLimiterOptions } from "./limiter"
export { ensureProposalFailures, recordProposalFailure } from "./failure-log"
export type { ProposalFailureRow } from "./failure-log"
export { classifyIntentSensitivity, classifySensitivity } from "./sensitivity"
export type { SensitivityClassifierOptions } from "./sensitivity"
