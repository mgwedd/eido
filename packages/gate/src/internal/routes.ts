import type { DatabaseSync } from "node:sqlite"
import { validateGateIntentProposal } from "@eido/schemas"
import type {
  GateIntentHistory,
  GatePendingIntentList,
  GateProposeRefusal,
  GateProposeResult,
} from "@eido/schemas"
import { append, verifyChain } from "./audit"
import { payloadHash } from "./canonical"
import { apiError, NOT_FOUND } from "./http"
import type { GateRequest, Handler, Reply } from "./http"
import {
  intentHistory,
  intentSummary,
  pendingIntents,
  propose,
} from "./intents"
import type { Policy } from "./policy"

// The gate's routes. The data-plane listener serves only the intent API: propose, and three
// read-only views without payload bodies. The control listener is a separate socket that the
// data plane is never given; it serves the same reads plus the audit chain check. The phone
// listener (#85) and the Mac-local admin listener (#78) are further handlers over the same
// server wrapper, each on its own listener.

export type GateState = { db: DatabaseSync; policy: Policy }

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

async function proposeRoute(
  request: GateRequest,
  gate: GateState
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
  })
  if (result.ok) {
    const stored: GateProposeResult = {
      id: result.intentId,
      tier: result.tier,
      state: result.state,
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

const INTENT_PATH = /^\/intents\/([^/]+)(\/history)?$/

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

/** The data-plane listener: the intent API and nothing else. */
export function dataPlaneHandler(gate: () => GateState): Handler {
  return (request) => {
    const state = gate()
    if (request.method === "POST" && request.path === "/intents") {
      return proposeRoute(request, state)
    }
    return readRoute(request, state) ?? NOT_FOUND
  }
}

/** The control listener: the intent reads plus the audit chain check. Never given to the data plane. */
export function controlHandler(gate: () => GateState): Handler {
  return (request) => {
    const state = gate()
    if (request.method === "GET" && request.path === "/audit/chain") {
      return { status: 200, body: verifyChain(state.db) }
    }
    return readRoute(request, state) ?? NOT_FOUND
  }
}
