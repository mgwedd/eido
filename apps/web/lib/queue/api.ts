import {
  validateCoreApiDocumentList,
  validateGateApiError,
  validateGateDecisionResult,
  validateGateIntentHistory,
  validateGatePendingIntentList,
  validateGatePrepareApproval,
  type GateDecisionRequest,
  type GateDecisionResult,
  type GateEditRequest,
  type GateIntentHistory,
  type GatePrepareApproval,
  type GateRejectReason,
} from "@eido/schemas"
import type { ApprovalResult } from "@/lib/approval/sign"
import type { PendingIntent } from "@/lib/today"

const APPROVALS_URL = "/api/gate/approvals"
const CORE_DOCUMENTS_URL = "/api/core/documents"

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

/**
 * The names of the documents an intent was built from, read from core by id. Core lists only live
 * documents, so an id with no live document is left out; a stored title of null becomes "Untitled".
 */
export async function loadSourceNames(
  documentIds: readonly string[],
  signal?: AbortSignal
): Promise<Loaded<string[]>> {
  const result = await getJson(
    `${CORE_DOCUMENTS_URL}?ids=${documentIds.map(encodeURIComponent).join(",")}&limit=200`,
    validateCoreApiDocumentList,
    signal
  )
  if (!result.ok) return result
  return {
    ok: true,
    value: result.value.documents.map((d) => d.name ?? "Untitled"),
  }
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
    if (response.status === 401)
      return {
        ok: false,
        error: { code: "unauthenticated", message: "Your session ended." },
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

/** Why the gate refused an edit; `other` covers a failure that is not a refusal. */
export type EditFailure = {
  code:
    | "tier_changed"
    | "forbidden"
    | "invalid_request"
    | "already_decided"
    | "not_found"
    | "unauthenticated"
    | "network"
    | "other"
  message: string
}

/**
 * Sends an edited intent to the gate, unsigned. The gate rejects the original, creates the new
 * pending intent and answers with it prepared for approval; the caller signs that with the
 * passkey. The edit approves nothing by itself.
 */
export async function editIntent(
  intentId: string,
  intent: GateEditRequest["intent"]
): Promise<
  { ok: true; value: GatePrepareApproval } | { ok: false; error: EditFailure }
> {
  const body: GateEditRequest = { intent }
  let response: Response
  try {
    response = await fetch(
      `${APPROVALS_URL}/${encodeURIComponent(intentId)}/edit`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    )
  } catch {
    return {
      ok: false,
      error: { code: "network", message: "The gate could not be reached." },
    }
  }
  const other = (message: string) => ({
    ok: false as const,
    error: { code: "other" as const, message },
  })
  try {
    const json: unknown = await response.json()
    if (!response.ok) {
      const refusal = validateGateApiError(json)
      if (
        refusal.ok &&
        (refusal.value.code === "tier_changed" ||
          refusal.value.code === "forbidden" ||
          refusal.value.code === "invalid_request" ||
          refusal.value.code === "already_decided" ||
          refusal.value.code === "not_found" ||
          refusal.value.code === "unauthenticated")
      )
        return {
          ok: false,
          error: { code: refusal.value.code, message: refusal.value.message },
        }
      return other(`The gate answered ${response.status}.`)
    }
    const parsed = validateGatePrepareApproval(json)
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : other("The gate sent an unreadable result.")
  } catch {
    return other(`The gate answered ${response.status}.`)
  }
}

export async function confirmFieldIntent(
  intentId: string,
  extractionId: string | number,
  field: string,
  value?: unknown
): Promise<{ ok: true; state: string } | { ok: false; message: string }> {
  try {
    const coreRes = await fetch(
      `/api/core/extractions/${encodeURIComponent(String(extractionId))}/confirm`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          field,
          ...(value !== undefined ? { value } : {}),
        }),
      }
    )
    if (!coreRes.ok) {
      let msg = `Extraction confirmation failed (${coreRes.status})`
      try {
        const errJson = (await coreRes.json()) as {
          error?: { message?: string }
        }
        if (errJson.error?.message) msg = errJson.error.message
      } catch {}
      return { ok: false, message: msg }
    }
  } catch {
    return { ok: false, message: "Could not reach Core API" }
  }

  const body: GateDecisionRequest = {
    intentId,
    decision: "approved",
  }
  try {
    const gateRes = await fetch(
      `/api/gate/approvals/${encodeURIComponent(intentId)}/decision`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    )
    if (!gateRes.ok) {
      return { ok: false, message: `Gate decision failed (${gateRes.status})` }
    }
    return { ok: true, state: "approved" }
  } catch {
    return { ok: false, message: "Could not reach Gate API" }
  }
}
