import type { CoreApiError, CoreApiObligationState } from "@eido/schemas"
import { LedgerError } from "../ledger/errors"
import type {
  ObligationChange,
  ObligationStateStore,
} from "../ledger/obligation-state"

/** POST /obligations/:id/done, /resolve and /reopen (#104). */
export const OBLIGATION_CHANGE_PATH =
  /^\/obligations\/([^/]+)\/(done|resolve|reopen)$/

export type ObligationChangeResult =
  | { ok: true; body: CoreApiObligationState }
  | {
      ok: false
      code: CoreApiError["error"]["code"]
      message: string
      fields?: { field: string; message: string }[]
    }

const ID = /^[1-9][0-9]{0,15}$/

/**
 * Applies the change named by a path that matched OBLIGATION_CHANGE_PATH. The body carries
 * nothing; it must be the empty JSON object, which keeps the route behind the JSON content type
 * that every core write requires.
 */
export async function changeObligation(
  store: ObligationStateStore,
  match: RegExpExecArray,
  body: unknown
): Promise<ObligationChangeResult> {
  const rawId = match[1] ?? ""
  // The path pattern admits only the three changes.
  const change = match[2] as ObligationChange
  const id = Number(rawId)
  if (!ID.test(rawId) || !Number.isSafeInteger(id)) {
    return { ok: false, code: "not_found", message: "no such obligation" }
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length > 0
  ) {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: [{ field: "", message: "must be an empty object" }],
    }
  }
  try {
    return { ok: true, body: await store.change(id, change) }
  } catch (error) {
    if (!(error instanceof LedgerError)) throw error
    if (error.code === "obligation_not_found") {
      return { ok: false, code: "not_found", message: "no such obligation" }
    }
    if (error.code === "invalid_transition") {
      return { ok: false, code: "invalid_transition", message: error.message }
    }
    if (error.code === "busy") {
      return { ok: false, code: "busy", message: "ledger busy, retry" }
    }
    throw error
  }
}
