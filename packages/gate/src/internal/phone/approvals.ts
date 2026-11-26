import type { DatabaseSync } from "node:sqlite"
import {
  validateGateDecisionRequest,
  validateGateEditRequest,
} from "@eido/schemas"
import type {
  GateDecisionResult,
  GateIntentHistory,
  GatePrepareApproval,
  GateUndoResult,
} from "@eido/schemas"
import { issueNonce, reject, verifyApproval } from "../approvals"
import type { PreparedApproval } from "../approvals"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"
import type { ExecutionResult } from "../executor"
import {
  approvalCard,
  decidePending,
  editIntent,
  intentHistory,
  intentSummary,
} from "../intents"
import type { EditResult } from "../intents"
import { proposeDraftDiscard } from "../draft-discard"
import type { Clock } from "../sessions"
import { jsonBody, invalid } from "./shared"
import type { PhoneState } from "./types"

/** The prepare response for an intent issueNonce just prepared. */
export function prepared(state: PhoneState, approval: PreparedApproval): Reply {
  if (!approval.ok) {
    return approval.code === "not_found"
      ? apiError(404, "not_found", "no such intent")
      : apiError(409, "already_decided", "the intent is no longer pending")
  }
  const card = approvalCard(state.db, approval.intentId)
  if (card === undefined) return apiError(404, "not_found", "no such intent")
  const body: GatePrepareApproval = {
    intentId: approval.intentId,
    kind: card.kind,
    origin: card.origin,
    state: "pending",
    payload: approval.payload,
    payloadHash: approval.payloadHash,
    nonce: approval.nonce,
    documentIds: card.documentIds,
    ...(card.contextPackId === null
      ? {}
      : { contextPackId: card.contextPackId }),
    ...(card.editedFrom === null ? {} : { editedFrom: card.editedFrom }),
    ...(card.rationale === null ? {} : { rationale: card.rationale }),
    ...(card.injection === null ? {} : { injection: card.injection }),
  }
  return { status: 200, body }
}

export function history(state: PhoneState, id: string): Reply {
  if (intentSummary(state.db, id) === undefined) {
    return apiError(404, "not_found", "no such intent")
  }
  const body: GateIntentHistory = {
    intentId: id,
    entries: intentHistory(state.db, id),
  }
  return { status: 200, body }
}

export async function decision(
  state: PhoneState,
  request: GateRequest,
  id: string,
  now: Clock,
  execute?: (id: string) => Promise<ExecutionResult>
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateDecisionRequest(body.value)
  if (!checked.ok) return invalid("a decision", checked.errors)
  const decided = checked.value
  if (decided.intentId !== id) {
    return apiError(400, "invalid_request", "intentId does not match the path")
  }
  if (decided.decision === "approved") {
    const row = state.db
      .prepare("SELECT kind, state FROM intents WHERE id = ?")
      .get(id)
    if (row === undefined) {
      return apiError(404, "not_found", "no such intent")
    }
    if (row["state"] !== "pending") {
      return apiError(409, "already_decided", "the intent is no longer pending")
    }
    if (row["kind"] === "confirm.field") {
      const decidedHash = decidePending(state.db, id, "approved", "approver")
      if (decidedHash === undefined) {
        return apiError(
          409,
          "already_decided",
          "the intent is no longer pending"
        )
      }
      const approved: GateDecisionResult = {
        intentId: id,
        state: "approved",
        nudge: false,
      }
      return { status: 200, body: approved }
    }
    if (!("assertion" in decided) || !("nonce" in decided)) {
      return apiError(403, "verification_failed", "the approval was refused")
    }
    const result = verifyApproval(
      state.db,
      state.webAuthn,
      {
        intentId: id,
        nonce: decided.nonce,
        assertion: decided.assertion,
      },
      {
        now,
        threshold: state.nudge?.threshold,
        windowMs: state.nudge?.windowMs,
      }
    )
    if (!result.ok) {
      return apiError(403, "verification_failed", "the approval was refused")
    }
    if (execute !== undefined) await execute(id)
    const approved: GateDecisionResult = {
      intentId: id,
      state: "approved",
      nudge: result.nudge,
    }
    return { status: 200, body: approved }
  }
  const result = reject(state.db, id, decided.reasonCode)
  if (!result.ok) {
    return result.code === "not_found"
      ? apiError(404, "not_found", "no such intent")
      : apiError(409, "already_decided", "the intent is no longer pending")
  }
  const rejected: GateDecisionResult = { intentId: id, state: "rejected" }
  return { status: 200, body: rejected }
}

const EDIT_REFUSALS = {
  not_found: [404, "not_found", "no such intent"],
  not_pending: [409, "already_decided", "the intent is no longer pending"],
  invalid_payload: [422, "invalid_request", "the edited intent is not valid"],
  kind_changed: [422, "invalid_request", "an edit cannot change the kind"],
  forbidden: [403, "forbidden", "policy forbids the edited intent"],
  tier_changed: [409, "tier_changed", "the edit would change the tier"],
} as const satisfies Record<
  Extract<EditResult, { ok: false }>["code"],
  readonly [number, Parameters<typeof apiError>[1], string]
>

export async function edit(
  state: PhoneState,
  request: GateRequest,
  id: string
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateEditRequest(body.value)
  if (!checked.ok) return invalid("an edit", checked.errors)
  const result = editIntent(
    state.db,
    state.policy,
    id,
    checked.value.intent,
    "approver"
  )
  if (!result.ok) {
    const [status, code, message] = EDIT_REFUSALS[result.code]
    const detail =
      result.code === "invalid_payload" && result.errors !== undefined
        ? `${message}: ${(result.errors[0] ?? "").slice(0, 200)}`
        : message
    return apiError(status, code, detail)
  }
  state.push?.notifyPending()
  return prepared(state, issueNonce(state.db, result.intentId))
}

const undoInFlight = new WeakMap<DatabaseSync, Set<string>>()

export async function discardDraft(
  state: PhoneState,
  request: GateRequest,
  id: string
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  if (
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value) ||
    Object.keys(body.value).length !== 0 ||
    id.length > 64
  )
    return apiError(
      400,
      "invalid_request",
      "expected an execution id and an empty object"
    )
  const proposed = proposeDraftDiscard(state.db, state.policy, id)
  if (proposed === undefined)
    return apiError(
      409,
      "unavailable",
      "this draft cannot be proposed for discard"
    )
  state.push?.notifyPending()
  return { status: 201, body: proposed }
}

export async function undo(
  state: PhoneState,
  request: GateRequest,
  id: string,
  executeUndo?: (id: string) => Promise<ExecutionResult>
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  if (
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value) ||
    Object.keys(body.value).length !== 0
  ) {
    return invalid("an empty undo request", ["expected an empty object"])
  }
  if (id.length > 64) {
    return apiError(400, "invalid_request", "the execution id is invalid")
  }
  if (executeUndo === undefined) {
    return apiError(503, "unavailable", "undo is not configured")
  }
  const activeUndos = undoInFlight.get(state.db)
  if (activeUndos?.has(id)) {
    return apiError(
      409,
      "already_decided",
      "this execution is already being undone"
    )
  }
  if (
    state.db
      .prepare("SELECT 1 FROM execution_undos WHERE intent_id=?")
      .get(id) !== undefined
  ) {
    return apiError(
      409,
      "already_decided",
      "this execution has already been undone"
    )
  }
  const undos = activeUndos ?? new Set<string>()
  if (activeUndos === undefined) undoInFlight.set(state.db, undos)
  undos.add(id)
  try {
    const result = await executeUndo(id)
    if (result.ok) {
      const response: GateUndoResult = { id, undone: true }
      return { status: 200, body: response }
    }
    if (result.code === "not_found") {
      return apiError(404, "not_found", "no such execution")
    }
    if (
      result.code === "upstream_error" ||
      result.code === "session_unavailable" ||
      result.code === "connector_unavailable" ||
      result.code === "connector_misconfigured" ||
      result.code === "unknown_writer" ||
      result.code === "changed_during_execution"
    ) {
      return apiError(503, "unavailable", "undo could not be completed")
    }
    return apiError(409, "already_decided", "this execution cannot be undone")
  } catch {
    return apiError(503, "unavailable", "undo could not be completed")
  } finally {
    undos.delete(id)
    if (undos.size === 0) undoInFlight.delete(state.db)
  }
}
