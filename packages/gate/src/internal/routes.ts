import type { DatabaseSync } from "node:sqlite"
import {
  validateGateAuditRecordRequest,
  validateGateIntentProposal,
  validateIntent,
} from "@eido/schemas"
import type {
  GateAuditRecordRequest,
  GateAuditRecordResult,
  GateConnectorHealth,
  GateIntentHistory,
  GatePendingIntentList,
  GateProposeRefusal,
  GateProposeResult,
} from "@eido/schemas"
import { append, verifyChain } from "./audit"
import { getConnectorHealth } from "./connector-health"
import { mailRoute } from "./bridge/mail-routes"
import type { MailReads } from "./bridge/mail-routes"
import { payloadHash } from "./canonical"
import { apiError, NOT_FOUND } from "./http"
import type { GateRequest, Handler, Reply } from "./http"
import { executionReceipt } from "./executor"
import type { ExecutionResult } from "./executor"
import {
  intentHistory,
  intentSummary,
  pendingIntents,
  propose,
} from "./intents"
import type { Policy } from "./policy"

// The gate's routes. The data-plane listener serves the intent API (propose, and three
// read-only views without payload bodies), connector health, and POST /audit, which appends one hash-only
// audit.profile.* row for a profile change in core (#181). The control listener is a separate socket that the
// data plane is never given; it serves the same reads plus the audit chain check. The phone
// listener (#85) and the Mac-local admin listener (#78) are further handlers over the same
// server wrapper, each on its own listener.

export type GateState = {
  db: DatabaseSync
  policy: Policy
  notifyPending?: () => void
}

const MAX_ERRORS = 50
const MAX_ERROR_LENGTH = 300

// Refusals before the intent is parsed are audited here; propose() audits everything after.
function auditRefusal(db: DatabaseSync, reason: string): void {
  append(db, {
    actor: "data-plane",
    action: `intent.request_refused.${reason}`,
    target: "intent",
    detailHash: payloadHash({ reason }),
  })
}

function trimmed(errors: readonly string[]): string[] {
  return errors
    .slice(0, MAX_ERRORS)
    .map((error) => error.slice(0, MAX_ERROR_LENGTH))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

async function proposeRoute(
  request: GateRequest,
  gate: GateState,
  execute?: (id: string) => Promise<ExecutionResult>
): Promise<Reply> {
  const body = await request.body()
  if (!body.ok) {
    auditRefusal(gate.db, "too_large")
    return apiError(413, "invalid_request", "the body is over 1 MiB")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    auditRefusal(gate.db, "malformed_json")
    return apiError(400, "invalid_request", "the body is not valid JSON")
  }
  const checked = validateGateIntentProposal(parsed)
  if (!checked.ok) {
    auditRefusal(gate.db, "invalid_request")
    return apiError(
      400,
      "invalid_request",
      `the body is not an intent proposal: ${trimmed(checked.errors)[0] ?? ""}`
    )
  }
  const proposal = checked.value
  const result = propose(gate.db, gate.policy, {
    intent: proposal.intent,
    origin: proposal.origin,
    ...(proposal.taskId === undefined ? {} : { taskId: proposal.taskId }),
    ...(proposal.sources === undefined
      ? {}
      : {
          contextPackId: proposal.sources.contextPackId,
          documentIds: proposal.sources.documentIds,
        }),
    ...(proposal.rationale === undefined
      ? {}
      : { rationale: proposal.rationale }),
  })
  if (result.ok) {
    if (result.state === "pending") gate.notifyPending?.()
    if (result.tier === "auto" && execute !== undefined) {
      await execute(result.intentId)
    }
    const stored: GateProposeResult = {
      id: result.intentId,
      tier: result.tier,
      state: intentSummary(gate.db, result.intentId)?.state ?? result.state,
    }
    return { status: 201, body: stored }
  }
  if (result.code === "invalid_payload") {
    const refusal: GateProposeRefusal = {
      code: "invalid_payload",
      errors: trimmed(result.errors),
    }
    return { status: 422, body: refusal }
  }
  const refused: GateProposeResult = {
    id: result.intentId,
    tier: "forbidden",
    state: "rejected",
    reason: result.errors[0] ?? result.code,
  }
  return { status: 403, body: refused }
}

const HEX64 = /^[0-9a-f]{64}$/

// Which sides of a change each action has: create and assign add a record (assign may replace
// one), delete and unassign remove one, update replaces one.
const SIDES = {
  "entity.create": { before: "absent", after: "present" },
  "entity.update": { before: "present", after: "present" },
  "entity.delete": { before: "present", after: "absent" },
  "account.assign": { before: "either", after: "present" },
  "account.unassign": { before: "present", after: "absent" },
} as const satisfies Record<
  GateAuditRecordRequest["action"],
  { before: Side; after: Side }
>

type Side = "present" | "absent" | "either"

function sideError(
  name: string,
  side: Side,
  value: string | null
): string | undefined {
  if (value !== null && !HEX64.test(value)) {
    return `$.${name}: not lowercase hex`
  }
  if (side === "present" && value === null) return `$.${name}: must be a hash`
  if (side === "absent" && value !== null) return `$.${name}: must be null`
  return undefined
}

/** The checks the schema cannot express: lowercase hex, and null where the action has no side. */
function entryError(entry: GateAuditRecordRequest): string | undefined {
  if (!HEX64.test(entry.subjectHash)) return "$.subjectHash: not lowercase hex"
  const sides = SIDES[entry.action]
  return (
    sideError("beforeHash", sides.before, entry.beforeHash) ??
    sideError("afterHash", sides.after, entry.afterHash)
  )
}

function auditRequestRefusal(db: DatabaseSync, reason: string): void {
  append(db, {
    actor: "data-plane",
    action: `audit.request_refused.${reason}`,
    target: "audit",
    detailHash: payloadHash({ reason }),
  })
}

// Appends the change as one row: the action names it, the target is the subject's hash and the
// detail hash covers the whole entry. Nothing in clear text reaches the log.
async function auditRoute(
  request: GateRequest,
  gate: GateState
): Promise<Reply> {
  const body = await request.body()
  if (!body.ok) {
    auditRequestRefusal(gate.db, "too_large")
    return apiError(413, "invalid_request", "the body is over 1 MiB")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    auditRequestRefusal(gate.db, "malformed_json")
    return apiError(400, "invalid_request", "the body is not valid JSON")
  }
  const checked = validateGateAuditRecordRequest(parsed)
  const error = checked.ok
    ? entryError(checked.value)
    : (trimmed(checked.errors)[0] ?? "")
  if (!checked.ok || error !== undefined) {
    auditRequestRefusal(gate.db, "invalid_request")
    return apiError(
      400,
      "invalid_request",
      `the body is not an audit entry: ${error ?? ""}`
    )
  }
  const entry = checked.value
  const { seq } = append(gate.db, {
    actor: "data-plane",
    action: `audit.profile.${entry.action}`,
    target: entry.subjectHash,
    detailHash: payloadHash({
      action: entry.action,
      subjectHash: entry.subjectHash,
      beforeHash: entry.beforeHash,
      afterHash: entry.afterHash,
    }),
  })
  const result: GateAuditRecordResult = { seq }
  return { status: 201, body: result }
}

const INTENT_PATH = /^\/intents\/([^/]+)(\/history)?$/
const RESTORE_PATH = /^\/intents\/([^/]+)\/restore$/

/** Create a fresh approval proposal from an executed Gmail trash's authenticated prior labels. */
function restoreTrashRoute(
  request: GateRequest,
  gate: GateState
): Reply | undefined {
  if (request.method !== "POST") return undefined
  const match = RESTORE_PATH.exec(request.path)
  if (match === null) return undefined
  const sourceId = decodeURIComponent(match[1] ?? "")
  const source = gate.db
    .prepare(
      "SELECT kind, payload_json, payload_hash, state FROM intents WHERE id=?"
    )
    .get(sourceId)
  const receipt = executionReceipt(gate.db, sourceId)
  if (
    source === undefined ||
    source["kind"] !== "email.trash" ||
    source["state"] !== "executed" ||
    receipt === undefined
  ) {
    return apiError(409, "unavailable", "this trash action cannot be restored")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(String(source["payload_json"]))
  } catch {
    return apiError(409, "unavailable", "this trash action cannot be restored")
  }
  const checked = validateIntent(parsed)
  const result = receipt.result
  const prior = isRecord(result) ? result["priorLabels"] : undefined
  if (
    !checked.ok ||
    checked.value.kind !== "email.trash" ||
    checked.value.connector !== "gmail" ||
    payloadHash(checked.value) !== String(source["payload_hash"]) ||
    !isRecord(prior)
  ) {
    return apiError(409, "unavailable", "this trash action cannot be restored")
  }
  const priorLabels = checked.value.args.messageIds.map((messageId) => {
    const labels = prior[messageId]
    return isStringArray(labels) ? { messageId, labels } : undefined
  })
  if (priorLabels.some((entry) => entry === undefined))
    return apiError(409, "unavailable", "this trash action cannot be restored")
  const proposed = propose(gate.db, gate.policy, {
    intent: {
      kind: "email.untrash",
      connector: "gmail",
      args: {
        sourceIntentId: sourceId,
        messageIds: checked.value.args.messageIds,
        priorLabels,
      },
    },
    origin: "reactive",
  })
  if (!proposed.ok) {
    auditRefusal(gate.db, "restore_unavailable")
    return apiError(409, "unavailable", "this trash action cannot be restored")
  }
  if (proposed.state === "pending") gate.notifyPending?.()
  return {
    status: 201,
    body: { id: proposed.intentId, tier: proposed.tier, state: proposed.state },
  }
}

function connectorHealthRoute(
  request: GateRequest,
  gate: GateState
): Reply | undefined {
  if (request.method !== "GET" || request.path !== "/connector-health") {
    return undefined
  }
  const result: GateConnectorHealth = {
    connectors: getConnectorHealth(gate.db),
  }
  return { status: 200, body: result }
}

/** The read-only intent views, or undefined when the request is not one of them. */
function readRoute(request: GateRequest, gate: GateState): Reply | undefined {
  if (request.method !== "GET") return undefined
  if (request.path === "/intents") {
    const query = [...request.query.entries()]
    if (query.length !== 1 || query[0]?.join("=") !== "state=pending") {
      return undefined
    }
    const list: GatePendingIntentList = {
      intents: pendingIntents(gate.db),
    }
    return { status: 200, body: list }
  }
  const match = INTENT_PATH.exec(request.path)
  if (match === null) return undefined
  const id = decodeURIComponent(match[1] ?? "")
  const summary = intentSummary(gate.db, id)
  if (summary === undefined) {
    return apiError(404, "not_found", "no such intent")
  }
  if (match[2] === undefined) return { status: 200, body: summary }
  const history: GateIntentHistory = {
    intentId: id,
    entries: intentHistory(gate.db, id),
  }
  return { status: 200, body: history }
}

/**
 * The data-plane listener: the intent API, POST /audit, connector health and, when Bridge is
 * configured, the Proton mail read routes (#195); nothing else.
 */
export function dataPlaneHandler(
  gate: () => GateState,
  mail?: MailReads,
  execute?: (id: string) => Promise<ExecutionResult>
): Handler {
  return (request) => {
    const state = gate()
    const restore = restoreTrashRoute(request, state)
    if (restore !== undefined) return restore
    if (request.method === "POST" && request.path === "/intents") {
      return proposeRoute(request, state, execute)
    }
    if (request.method === "POST" && request.path === "/audit") {
      return auditRoute(request, state)
    }
    const mailReply =
      mail === undefined ? undefined : mailRoute(request, state.db, mail)
    return (
      mailReply ??
      connectorHealthRoute(request, state) ??
      readRoute(request, state) ??
      NOT_FOUND
    )
  }
}

/** The control listener: the intent reads plus the audit chain check. Never given to the data plane. */
export function controlHandler(gate: () => GateState): Handler {
  return (request) => {
    const state = gate()
    if (request.method === "GET" && request.path === "/audit/chain") {
      return { status: 200, body: verifyChain(state.db) }
    }
    return (
      connectorHealthRoute(request, state) ??
      readRoute(request, state) ??
      NOT_FOUND
    )
  }
}
