// Public entry point of the gate: the intent API. Everything else in the package is internal.
import type { Intent } from "@eido/schemas"
import { issueNonce, reject, verifyApproval } from "./internal/approvals"
import type {
  ApprovalAssertion,
  ApprovalRequest,
  ApprovalResult,
  PreparedApproval,
  RejectResult,
} from "./internal/approvals"
import {
  intentHistory,
  intentStatus,
  pendingIntents,
  propose,
} from "./internal/intents"
import type {
  IntentHistoryEntry,
  IntentOrigin,
  IntentState,
  IntentStatus,
  PendingIntentSummary,
  ProposeResult,
} from "./internal/intents"
import type { Tier } from "./internal/policy"
import { runningGate } from "./internal/runtime"

export type IntentKind = Intent["kind"]
export type {
  ApprovalAssertion,
  ApprovalRequest,
  ApprovalResult,
  PreparedApproval,
  RejectResult,
  IntentHistoryEntry,
  IntentOrigin,
  IntentState,
  IntentStatus,
  PendingIntentSummary,
  Tier,
}

export type ProposeIntentInput = {
  kind: IntentKind
  /** The intent's args, validated against the verb schema for `kind`. */
  payload: unknown
  origin: IntentOrigin
  taskId?: string
  contextPackId?: string
}

export type ProposeIntentResult = ProposeResult

export type IntentProposal = {
  /** A whole intent (`{ kind, args }`), validated against the intent schemas. */
  intent: unknown
  origin: IntentOrigin
  sources: { contextPackId: string; documentIds: string[] }
}

export type IntentProposalResult =
  | { ok: true; intentId: string; status: IntentState }
  | { ok: false; code: string; path?: string; reason: string }

/** The port through which the model and ask pipeline (#27) proposes intents. It never executes. */
export type IntentProposalPort = (
  proposal: IntentProposal
) => Promise<IntentProposalResult>

/**
 * Proposes one write. The gate validates, canonicalizes, hashes and tiers it: `auto` lands in
 * approved, `approval` in pending, and a forbidden or disabled-connector intent is stored
 * rejected. Any hash the caller supplies is ignored.
 */
export function proposeIntent(
  input: ProposeIntentInput
): Promise<ProposeIntentResult> {
  return Promise.resolve().then(() => {
    const gate = runningGate()
    return propose(gate.db, gate.policy, {
      intent: { kind: input.kind, args: input.payload },
      origin: input.origin,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.contextPackId === undefined
        ? {}
        : { contextPackId: input.contextPackId }),
    })
  })
}

// Validator errors read "$.args.to: required"; the port reports the path and the reason apart.
const ERROR_PATH = /^(\$\S*): (.+)$/

function failure(
  code: string,
  errors: readonly string[]
): IntentProposalResult {
  const first = errors[0] ?? code
  const [, path, reason] = ERROR_PATH.exec(first) ?? []
  return path !== undefined && reason !== undefined
    ? { ok: false, code, path, reason }
    : { ok: false, code, reason: first }
}

export const proposeIntentFromModel: IntentProposalPort = (proposal) =>
  Promise.resolve().then(() => {
    const gate = runningGate()
    const result = propose(gate.db, gate.policy, {
      intent: proposal.intent,
      origin: proposal.origin,
      contextPackId: proposal.sources.contextPackId,
      documentIds: proposal.sources.documentIds,
    })
    if (!result.ok) return failure(result.code, result.errors)
    return { ok: true, intentId: result.intentId, status: result.state }
  })

/** State and tier of one intent, or undefined when there is none. No payload. */
export function getIntentStatus(intentId: string): IntentStatus | undefined {
  return intentStatus(runningGate().db, intentId)
}

/** The intent's state transitions, oldest first, from the audit log. No payload. */
export function getIntentHistory(intentId: string): IntentHistoryEntry[] {
  return intentHistory(runningGate().db, intentId)
}

/** Intents waiting for an approval, oldest first. No payload. */
export function listPendingIntents(): PendingIntentSummary[] {
  return pendingIntents(runningGate().db)
}

/**
 * Prepares the approval card for a pending intent (#32 prepareApproval): issues a fresh
 * single-use nonce, superseding the one from any earlier call, and returns it with the stored
 * canonical payload and its hash. A non-pending intent gets no nonce.
 */
export function prepareApproval(intentId: string): PreparedApproval {
  return issueNonce(runningGate().db, intentId)
}

/**
 * Approves a pending intent with a WebAuthn assertion over the challenge for the nonce from the
 * latest prepareApproval. On success the intent is approved, exactly once. Any failure returns
 * the same generic error; a challenge or payload mismatch also rejects the intent.
 */
export function approveIntent(request: ApprovalRequest): ApprovalResult {
  const gate = runningGate()
  return verifyApproval(gate.db, gate.webAuthn, request)
}

/** Rejects a pending intent, recording the optional reason code. */
export function rejectIntent(
  intentId: string,
  reasonCode?: string
): RejectResult {
  return reject(runningGate().db, intentId, reasonCode)
}
