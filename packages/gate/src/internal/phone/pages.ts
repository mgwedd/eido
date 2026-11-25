import {
  INTENT_KINDS,
  gateAuditDisplayActor,
  validateGateAuditPageRequest,
  validateIntent,
} from "@eido/schemas"
import type {
  GateAuditActor,
  GateAuditPage,
  GatePasskeyList,
  GatePermissionList,
} from "@eido/schemas"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"
import { kindTier } from "../policy"
import { listPasskeys } from "../credentials"
import { readBackupStatus } from "../backup-status"
import { describeIntent } from "../audit-description"
import { isUnsafeInverse } from "../executor"
import { sessionCredential, sessionToken } from "../sessions"
import type { Clock } from "../sessions"
import type { PhoneState } from "./types"

function auditActor(value: string): GateAuditActor {
  switch (value) {
    case "data-plane":
    case "policy":
    case "approver":
    case "executor":
    case "system":
    case "owner":
    case "gate":
      return value
    default:
      throw new Error("stored audit actor is not recognized")
  }
}

/**
 * Whether the executor refuses the stored inverse of this execution on every attempt (#851), by the
 * executor's own rule. An execution whose recorded intent no longer checks out is refused too
 * (`hash_mismatch`), so neither is offered.
 */
function undoAlwaysRefused(row: Record<string, unknown>): boolean {
  const payload = row["payload_json"]
  const inverse = row["inverse_op"]
  if (typeof payload !== "string" || typeof inverse !== "string") return true
  const original = validateIntent(JSON.parse(payload))
  return !original.ok || isUnsafeInverse(original.value, JSON.parse(inverse))
}

export function auditPage(state: PhoneState, request: GateRequest): Reply {
  const raw: Record<string, unknown> = {}
  for (const key of new Set([...request.query.keys()])) {
    if (
      (key !== "before" && key !== "limit") ||
      request.query.getAll(key).length !== 1
    ) {
      return apiError(400, "invalid_request", "invalid audit page query")
    }
    const value = request.query.get(key)
    if (value === null || !/^\d+$/.test(value)) {
      return apiError(400, "invalid_request", "invalid audit page query")
    }
    raw[key] = Number(value)
  }
  const checked = validateGateAuditPageRequest(raw)
  if (!checked.ok) {
    return apiError(
      400,
      "invalid_request",
      checked.errors[0] ?? "invalid audit page query"
    )
  }
  const { before, limit = 50 } = checked.value
  // An Undo attempt is claimed once and never repeated (the executor answers `outcome_unresolved`
  // to every retry), so a claimed attempt without a result is not offered again. A refusal the
  // executor makes before claiming (its `UNCLAIMED_UNDO_REFUSALS`) leaves no attempt row, so Undo
  // stays offered and a retry can succeed (#846).
  const columns = `SELECT a.seq, a.ts, a.actor, a.action, a.target, a.detail_hash,
      EXISTS (
        SELECT 1 FROM approvals p
        JOIN approval_nonces n ON n.nonce = p.nonce AND n.intent_id = p.intent_id
        JOIN credentials c ON c.credential_id = p.credential_id
        JOIN intents i ON i.id = p.intent_id
        WHERE p.intent_id = a.target AND p.decision = 'approved'
          AND p.signature IS NOT NULL AND p.bundle_hash = i.payload_hash
          AND n.used_at IS NOT NULL
          AND (c.revoked_at IS NULL OR c.revoked_at >= p.decided_at)
          AND p.decided_at <= a.ts
      ) AS approved,
      CASE WHEN e.audit_seq = a.seq THEN
        CASE WHEN u.intent_id IS NOT NULL THEN 'done'
             WHEN t.intent_id IS NOT NULL THEN 'none'
             WHEN e.inverse_op IS NOT NULL AND (i.tier = 'auto' OR (i.kind = 'file.delete' AND i.tier = 'approval')) THEN 'available'
             ELSE 'none' END
      ELSE 'none' END AS undo,
      CASE WHEN e.audit_seq = a.seq AND i.tier = 'auto' THEN i.payload_json END AS intent_json,
      e.inverse_op AS inverse_op, i.payload_json AS payload_json
    FROM audit_log a
    LEFT JOIN executions e ON e.audit_seq = a.seq
    LEFT JOIN execution_undos u ON u.intent_id = e.intent_id
    LEFT JOIN execution_attempts t ON t.intent_id = e.intent_id AND t.direction = 'undo'
    LEFT JOIN intents i ON i.id = e.intent_id`
  const selected =
    before === undefined
      ? state.db
          .prepare(`${columns} ORDER BY a.seq DESC LIMIT ?`)
          .all(limit + 1)
      : state.db
          .prepare(`${columns} WHERE a.seq < ? ORDER BY a.seq DESC LIMIT ?`)
          .all(before, limit + 1)
  const hasMore = selected.length > limit
  const pageRows = selected.slice(0, limit)
  const entries: GateAuditPage["entries"] = pageRows.map((row) => {
    const actor = auditActor(String(row["actor"]))
    const approved = Number(row["approved"]) === 1
    const state = row["undo"]
    if (state !== "available" && state !== "done" && state !== "none") {
      throw new Error("stored undo state is not recognized")
    }
    const undo =
      state === "available" && undoAlwaysRefused(row) ? "none" : state
    const intentJson = row["intent_json"]
    const description =
      typeof intentJson === "string" ? describeIntent(intentJson) : undefined
    return {
      seq: Number(row["seq"]),
      ts: String(row["ts"]),
      actor,
      displayActor: gateAuditDisplayActor(actor, approved),
      action: String(row["action"]),
      target: String(row["target"]),
      detailHash: String(row["detail_hash"]),
      undo,
      ...(description === undefined ? {} : { description }),
    }
  })
  const lastEntry = entries.at(-1)
  const body: GateAuditPage = {
    entries,
    ...(hasMore && lastEntry !== undefined
      ? { nextBefore: lastEntry.seq }
      : {}),
  }
  return { status: 200, body }
}

export function backupStatusRoute(state: PhoneState, now: Clock): Reply {
  const body = readBackupStatus(state.backupStampPath, now)
  return { status: 200, body }
}

export function passkeyList(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Reply {
  const current = sessionCredential(
    state.db,
    sessionToken(request.headers.cookie),
    now
  )
  const body: GatePasskeyList = { passkeys: listPasskeys(state.db, current) }
  return { status: 200, body }
}

export function permissionList(state: PhoneState): Reply {
  const tiers: GatePermissionList["tiers"] = INTENT_KINDS.map((kind) => {
    const decision = kindTier(state.db, state.policy, kind)
    const override = state.policy.overlay?.tiers[kind]
    const configured = {
      kind,
      default: state.policy.shipped.tiers[kind] ?? null,
      ...(override === undefined ? {} : { override }),
    }
    return decision.tier === "forbidden"
      ? { ...configured, tier: decision.tier, reason: decision.reason }
      : { ...configured, tier: decision.tier }
  })
  const body: GatePermissionList = {
    tiers,
    forbiddenKinds: tiers
      .filter((entry) => entry.tier === "forbidden")
      .map((entry) => entry.kind),
  }
  return { status: 200, body }
}
