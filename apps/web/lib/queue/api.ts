import {
  validateGateDecisionResult,
  validateGateIntentHistory,
  validateGatePendingIntentList,
  type GateDecisionRequest,
  type GateDecisionResult,
  type GateIntentHistory,
  type GateRejectReason,
} from "@eido/schemas"
import type { ApprovalResult } from "@/lib/approval/sign"
import { sha256Hex } from "@/lib/queue/hash"
import type { PendingIntent } from "@/lib/today"

const APPROVALS_URL = "/api/gate/approvals"

export type Loaded<T> =
  { ok: true; value: T } | { ok: false; status: number | "network" }

async function getJson<T>(
  url: string,
  validate: (
    input: unknown
  ) => { ok: true; value: T } | { ok: false; errors: unknown },
  signal?: AbortSignal
): Promise<Loaded<T>> {
  try {
    const response = await fetch(url, { cache: "no-store", signal })
    if (!response.ok) return { ok: false, status: response.status }
    const parsed = validate(await response.json())
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : { ok: false, status: 502 }
  } catch {
    return { ok: false, status: "network" }
  }
}

/** The pending intents, oldest first. */
export async function loadQueue(
  signal?: AbortSignal
): Promise<Loaded<PendingIntent[]>> {
  const result = await getJson(
    APPROVALS_URL,
    validateGatePendingIntentList,
    signal
  )
  if (!result.ok) return result
  const sorted = [...result.value.intents].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  )
  return { ok: true, value: sorted }
}

export function loadHistory(
  intentId: string,
  signal?: AbortSignal
): Promise<Loaded<GateIntentHistory>> {
  return getJson(
    `${APPROVALS_URL}/${encodeURIComponent(intentId)}/history`,
    validateGateIntentHistory,
    signal
  )
}

/** Rejects an intent; the reason is optional and feeds the evals. */
export async function rejectIntent(
  intentId: string,
  reasonCode?: GateRejectReason
): Promise<ApprovalResult<GateDecisionResult>> {
  const body: GateDecisionRequest = {
    intentId,
    decision: "rejected",
    ...(reasonCode ? { reasonCode } : {}),
  }
  try {
    const response = await fetch(
      `${APPROVALS_URL}/${encodeURIComponent(intentId)}/decision`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    )
    if (response.status === 409)
      return {
        ok: false,
        error: { code: "already_decided", message: "Already decided." },
      }
    if (!response.ok)
      return {
        ok: false,
        error: {
          code: "invalid_response",
          message: `The gate answered ${response.status}.`,
        },
      }
    const parsed = validateGateDecisionResult(await response.json())
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : {
          ok: false,
          error: {
            code: "invalid_response",
            message: "The gate sent an unreadable result.",
          },
        }
  } catch {
    return {
      ok: false,
      error: { code: "network", message: "The gate could not be reached." },
    }
  }
}

/** True when the payload text hashes to the hash the gate sent with it. */
export async function payloadMatchesHash(
  payload: string,
  payloadHash: string
): Promise<boolean> {
  return (await sha256Hex(payload)) === payloadHash
}
