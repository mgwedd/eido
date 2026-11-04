import type { DatabaseSync } from "node:sqlite"
import type {
  CoreApiSimpleFinAccount,
  CoreApiSimpleFinAccountList,
} from "@eido/schemas"
import { validateCoreApiSimpleFinAssignmentRequest } from "@eido/schemas"
import {
  assignSimpleFinAccount,
  listSimpleFinAccounts,
} from "../connectors/simplefin/accounts"

/** GET /connectors/simplefin/accounts (#545): the stored SimpleFIN accounts and their entities. */
export const SIMPLEFIN_ACCOUNTS_PATH = "/connectors/simplefin/accounts"
/**
 * PUT /connectors/simplefin/assignments (#545): assigns an account its entity. The account id is
 * in the body, not the path, so it never appears in a URL.
 */
export const SIMPLEFIN_ASSIGNMENTS_PATH = "/connectors/simplefin/assignments"

export interface SimpleFinAccountsDeps {
  db: DatabaseSync
  /** Starts a backfill of newly assigned accounts; the route does not wait for it. */
  backfill: () => Promise<void>
}

export function listSimpleFinAccountsRoute(
  deps: SimpleFinAccountsDeps
): CoreApiSimpleFinAccountList {
  return { accounts: listSimpleFinAccounts(deps.db) }
}

export type AssignRouteResult =
  | { ok: true; body: CoreApiSimpleFinAccount }
  | {
      ok: false
      code: "not_found" | "invalid"
      message: string
      /** Schema issues ("$.field: message") or store issues ("field: message"). */
      issues?: string[]
    }

/**
 * Stores the assignment as local configuration (no gate, no approval) and, when the account now
 * waits for a backfill, starts one without waiting: the read can take a while, and a spent budget
 * leaves it for a later tick.
 */
export async function assignSimpleFinAccountRoute(
  deps: SimpleFinAccountsDeps,
  body: unknown
): Promise<AssignRouteResult> {
  const checked = validateCoreApiSimpleFinAssignmentRequest(body)
  if (!checked.ok) {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      issues: checked.errors,
    }
  }
  const { accountId, entityId } = checked.value
  const result = await assignSimpleFinAccount(deps.db, accountId, entityId)
  if (result.status === "unknown_account") {
    return { ok: false, code: "not_found", message: "no such account" }
  }
  if (result.status === "unknown_entity") {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      issues: ["entityId: no such entity"],
    }
  }
  if (result.account.backfillPending) void deps.backfill()
  return { ok: true, body: result.account }
}
