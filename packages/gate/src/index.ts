// Public entry point of the gate: the intent API and audit clients the data plane uses to reach the gate
// process over its data-plane socket (ADR 0003). Everything else in the package is internal
// and runs only inside the gate process (src/main.ts).
import type {
  GateAuditRecordRequest,
  GateAuditRecordResult,
  GateIntentHistory,
  GateIntentState,
  GateIntentStatus,
  GatePendingIntentList,
  GateProposeResult,
  GateTier,
  Intent,
} from "@eido/schemas"

export {
  GateRequestError,
  GateUnavailableError,
  createAuditClient,
  createIntentClient,
} from "./internal/client"
export type {
  AuditClient,
  IntentClient,
  IntentClientOptions,
  IntentProposal,
} from "./internal/client"

export type IntentKind = Intent["kind"]
export type ProposeResult = GateProposeResult
export type IntentStatus = GateIntentStatus
export type IntentHistoryEntry = GateIntentHistory["entries"][number]
export type PendingIntentSummary = GatePendingIntentList["intents"][number]
export type IntentState = GateIntentState
export type Tier = GateTier
export type AuditRecordRequest = GateAuditRecordRequest
export type AuditRecordResult = GateAuditRecordResult
