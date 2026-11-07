import { validateGateApiError, type ValidationResult } from "@eido/schemas"

/** The gate's phone listener, as the browser reaches it through tailscale serve. */
export const GATE_URL = "/api/gate"

/**
 * What one Admin call to the gate came to. `unreachable`: fetch itself failed (the gate is not
 * answering on the host). `expired`: 401, the passkey session ended. `step-up`: 403
 * `step_up_required`, the route needs a fresh step-up. `refused`: any other answer the gate
 * gave with its code. `invalid`: the answer did not match its schema.
 */
export type GateOutcome<T> =
  | { kind: "ok"; status: number; value: T }
  | { kind: "unreachable" }
  | { kind: "expired" }
  | { kind: "step-up" }
  | { kind: "refused"; status: number; code: string }
  | { kind: "invalid" }

type Init = {
  method?: "GET" | "POST"
  body?: unknown
  signal?: AbortSignal
}

/**
 * Calls one gate route and checks the answer with `validate`. Bodies go as JSON straight to the
 * gate; nothing here logs or keeps them.
 */
export async function callGate<T>(
  path: string,
  validate: (value: unknown) => ValidationResult<T>,
  init: Init = {}
): Promise<GateOutcome<T>> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST")
  let response: Response
  try {
    response = await fetch(`${GATE_URL}${path}`, {
      method,
      cache: "no-store",
      ...(method === "POST"
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(init.body ?? {}),
          }
        : {}),
      signal: init.signal,
    })
  } catch (error) {
    if (init.signal?.aborted) throw error
    return { kind: "unreachable" }
  }
  if (response.status === 401) return { kind: "expired" }
  let json: unknown
  try {
    json = await response.json()
  } catch {
    return response.ok
      ? { kind: "invalid" }
      : { kind: "refused", status: response.status, code: "unknown" }
  }
  if (!response.ok) {
    const error = validateGateApiError(json)
    const code = error.ok ? error.value.code : "unknown"
    if (response.status === 403 && code === "step_up_required")
      return { kind: "step-up" }
    return { kind: "refused", status: response.status, code }
  }
  const parsed = validate(json)
  return parsed.ok
    ? { kind: "ok", status: response.status, value: parsed.value }
    : { kind: "invalid" }
}

/** For routes whose answer the page does not read: any JSON object passes. */
export function anyJson(value: unknown): ValidationResult<unknown> {
  return { ok: true, value }
}
