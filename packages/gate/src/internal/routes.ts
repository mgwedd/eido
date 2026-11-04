import type { DatabaseSync } from "node:sqlite"
import {
  validateGateAuditRecordRequest,
  validateGateIntentProposal,
  validateGatePasskeyRevokeRequest,
  validateIntent,
} from "@eido/schemas"
import type {
  GateAuditRecordRequest,
  GateAuditRecordResult,
  GateConnectorHealth,
  GateEnrolmentCode,
  GateIntentHistory,
  GateIntentStatus,
  GatePasskeyList,
  GatePendingIntentList,
  GateProposeRefusal,
  GateProposeResult,
} from "@eido/schemas"
import { append, verifyChain } from "./audit"
import { getConnectorHealth } from "./connector-health"
import { connectedRoute } from "./connector-connect"
import type { ConnectorProbes } from "./connector-connect"
import { listPasskeys, revokeByFingerprint } from "./credentials"
import { issueEnrolmentCode } from "./enrolment"
import { mailRoute } from "./bridge/mail-routes"
import type { MailReads } from "./bridge/mail-routes"
import { thingsRoute } from "./things/things-routes"
import type { ThingsReads } from "./things/things-adapter"
import { payloadHash } from "./canonical"
import { apiError, NOT_FOUND } from "./http"
import type { GateRequest, Handler, Reply } from "./http"
import { draftDiscarded } from "./draft-discard"
import { executionReceipt } from "./executor"
import type { ExecutionResult } from "./executor"
import {
  intentHistory,
  intentSummary,
  pendingIntents,
  propose,
} from "./intents"
import type { Policy } from "./policy"
import type { Clock } from "./sessions"
import type { ProfileAudit } from "./profile-audit"
import type { FileHelper } from "./files/file-helper"
import type { FileReads } from "./files/file-reads"
import { fileReadRoute } from "./files/file-reads"
import { fileRootRoute } from "./file-root-routes"
import type { WebAuthnConfig } from "./webauthn"

// The gate's routes. The data-plane listener serves the intent API (propose, and three
// read-only views without payload bodies), connector health, and POST /audit, which appends one
// hash-only audit.profile.* row for a profile change in core (#181), audit.ledger.* row for an
// obligation state change (#104), or audit.access.* row for sensitive reads and uses (#322). The control listener is a separate socket that the
// data plane is never given; it serves the same reads, the audit chain check and the owner's
// enrolment codes (#78). The phone listener (#85) is a further handler over the same server
// wrapper, on its own listener.

export type GateState = {
  db: DatabaseSync
  policy: Policy
  notifyPending?: () => void
  profileAudit?: ProfileAudit
  fileHelper?: FileHelper
  files?: FileReads
  webAuthn?: WebAuthnConfig
  /** Health probes by connector name, run after the owner connects one (#98). */
  probes?: ConnectorProbes
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
    ...(proposal.injection === undefined
      ? {}
      : { injection: proposal.injection }),
    ...(proposal.sensitivity === undefined
      ? {}
      : { sensitivity: proposal.sensitivity }),
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
// one), delete and unassign remove one, update replaces one. An obligation state change (#104)
// replaces the obligation's state record. Sensitive reads and local AI uses (#322) have neither side.
const SIDES = {
  "entity.create": { before: "absent", after: "present" },
  "entity.update": { before: "present", after: "present" },
  "entity.delete": { before: "present", after: "absent" },
  "account.assign": { before: "either", after: "present" },
  "account.unassign": { before: "present", after: "absent" },
  "obligation.done": { before: "present", after: "present" },
  "obligation.resolve": { before: "present", after: "present" },
  "obligation.reopen": { before: "present", after: "present" },
  defaultEntity: { before: "either", after: "either" },
  "access.document_open": { before: "absent", after: "absent" },
  "access.inference_use": { before: "absent", after: "absent" },
  "access.content_copy": { before: "absent", after: "absent" },
  "access.instruction_change": { before: "absent", after: "absent" },
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

// Obligation state changes are ledger rows; entity and account changes are profile rows;
// sensitive reads and local AI uses are access rows (#322).
function auditGroup(action: GateAuditRecordRequest["action"]): string {
  if (action.startsWith("access.")) return "audit.access"
  return action.startsWith("obligation.") ? "audit.ledger" : "audit.profile"
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
  let digests = {
    subjectHash: entry.subjectHash,
    beforeHash: entry.beforeHash,
    afterHash: entry.afterHash,
  }
  if (
    auditGroup(entry.action) === "audit.profile" ||
    auditGroup(entry.action) === "audit.access"
  ) {
    try {
      if (gate.profileAudit === undefined) throw new Error("unavailable")
      digests = await gate.profileAudit.tag(entry)
    } catch {
      return apiError(503, "unavailable", "profile audit key is unavailable")
    }
  }
  const group = auditGroup(entry.action)
  const actionName = entry.action.startsWith("access.")
    ? entry.action.slice("access.".length)
    : entry.action
  const storedAction = `${group}.${actionName}`
  const { seq } = append(gate.db, {
    actor: "data-plane",
    action: storedAction,
    target: digests.subjectHash,
    detailHash: payloadHash({
      action: entry.action,
      ...digests,
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
  if (match[2] === undefined) {
    const status: GateIntentStatus = {
      ...summary,
      discarded: draftDiscarded(gate.db, id),
    }
    return { status: 200, body: status }
  }
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
  execute?: (id: string) => Promise<ExecutionResult>,
  things?: ThingsReads
): Handler {
  return async (request) => {
    const state = gate()
    const fileReply = await fileReadRoute(request, state.files)
    if (fileReply !== undefined) return fileReply
    const restore = restoreTrashRoute(request, state)
    if (restore !== undefined) return restore
    if (request.method === "POST" && request.path === "/intents") {
      return proposeRoute(request, state, execute)
    }
    if (request.method === "POST" && request.path === "/audit") {
      return auditRoute(request, state)
    }
    const thingsReply =
      things === undefined
        ? undefined
        : await thingsRoute(request, state.db, things)
    if (thingsReply !== undefined) return thingsReply
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

// The owner issues a phone enrolment code from the Mac (#78). Only the control socket, readable
// by the gate user alone, serves this; the phone listener 404s it.
function enrolmentCodeRoute(db: DatabaseSync, now: Clock): Reply {
  const issued = issueEnrolmentCode(db, "admin", now)
  if (!issued.ok)
    return apiError(403, "forbidden", "enrolment codes are issued on the Mac")
  const body: GateEnrolmentCode = {
    code: issued.code,
    expiresAt: issued.expiresAt.toISOString(),
  }
  return { status: 201, body }
}

// The owner revokes a lost or replaced phone's passkey from the Mac (#419), by the fingerprint
// GET /passkeys lists. Like enrolment codes, only the control socket serves this; the phone
// listener has no revoke route, so a stolen phone session cannot revoke the owner's key.
async function revokePasskeyRoute(
  request: GateRequest,
  db: DatabaseSync
): Promise<Reply> {
  const body = await request.body()
  if (!body.ok) {
    return apiError(413, "invalid_request", "the body is over 1 MiB")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    return apiError(400, "invalid_request", "the body is not valid JSON")
  }
  const checked = validateGatePasskeyRevokeRequest(parsed)
  if (!checked.ok) {
    return apiError(400, "invalid_request", "the body must name a fingerprint")
  }
  const revoked = revokeByFingerprint(db, "admin", checked.value.fingerprint)
  if (!revoked.ok) {
    return revoked.code === "already_revoked"
      ? apiError(409, "already_decided", "the passkey is already revoked")
      : apiError(404, "not_found", "no passkey has that fingerprint")
  }
  const list: GatePasskeyList = { passkeys: listPasskeys(db) }
  return { status: 200, body: list }
}

/**
 * The control listener: the intent reads, the audit chain check, enrolment codes, passkey
 * revocation and the connector check after a connect (#98). Never given to the data plane or the phone.
 */
export function controlHandler(gate: () => GateState, now: Clock): Handler {
  return async (request) => {
    const state = gate()
    const fileReply = await fileRootRoute(request, state)
    if (fileReply !== undefined) return fileReply
    if (request.method === "GET" && request.path === "/passkeys") {
      const body: GatePasskeyList = { passkeys: listPasskeys(state.db) }
      return { status: 200, body }
    }
    if (request.method === "POST" && request.path === "/passkeys/revoke") {
      return revokePasskeyRoute(request, state.db)
    }
    if (request.method === "GET" && request.path === "/audit/chain") {
      return { status: 200, body: verifyChain(state.db) }
    }
    if (request.method === "POST" && request.path === "/enrolment-codes") {
      return enrolmentCodeRoute(state.db, now)
    }
    const connected = await connectedRoute(
      request,
      state.db,
      state.probes,
      () => now().getTime()
    )
    if (connected !== undefined) return connected
    return (
      connectorHealthRoute(request, state) ??
      readRoute(request, state) ??
      NOT_FOUND
    )
  }
}
