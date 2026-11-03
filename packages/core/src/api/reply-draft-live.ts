import type { DatabaseSync } from "node:sqlite"
import { GateRequestError } from "@eido/gate"
import type { IntentClient, IntentStatus } from "@eido/gate"

/** Gate states after which a draft intent is gone: refused, or the write failed. */
const DEAD_STATES = new Set<IntentStatus["state"]>(["rejected", "failed"])

/** Whether a proposed draft in this gate state still holds its thread. */
export function draftStateIsLive(state: IntentStatus["state"]): boolean {
  return !DEAD_STATES.has(state)
}

/**
 * The gate's status for a stored reply draft intent while the draft is still live, else null.
 * A draft is gone when the gate refused it or its write failed, when its discard executed (#549),
 * or when the gate no longer knows the intent (its store was reset: 404). Any other gate error
 * is thrown.
 */
export async function liveDraftStatus(
  gate: Pick<IntentClient, "status">,
  intentId: string
): Promise<IntentStatus | null> {
  try {
    const status = await gate.status(intentId)
    return draftStateIsLive(status.state) && !status.discarded ? status : null
  } catch (error) {
    if (error instanceof GateRequestError && error.status === 404) return null
    throw error
  }
}

/**
 * The stored draft intent id of each of these threads that has one in `reply_drafts`. The table
 * is created by the first draft, so a database without it has none.
 */
export function storedDraftIntentIds(
  db: DatabaseSync,
  threadKeys: readonly string[]
): Map<string, string> {
  const ids = new Map<string, string>()
  if (threadKeys.length === 0) return ids
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reply_drafts'"
    )
    .get()
  if (table === undefined) return ids
  const rows = db
    .prepare(
      "SELECT thread_key, intent_id FROM reply_drafts WHERE thread_key IN (SELECT value FROM json_each(?))"
    )
    .all(JSON.stringify(threadKeys))
  for (const row of rows) {
    ids.set(String(row["thread_key"]), String(row["intent_id"]))
  }
  return ids
}

/**
 * The threads among these whose stored draft is still live (see liveDraftStatus). When the gate
 * cannot answer for a stored draft (unreachable, or an error other than 404), the draft counts
 * as live: it was live when stored, and a list read must not fail because the gate is down.
 */
export async function threadsWithLiveDraft(
  db: DatabaseSync,
  gate: Pick<IntentClient, "status">,
  threadKeys: readonly string[]
): Promise<Set<string>> {
  const stored = [...storedDraftIntentIds(db, threadKeys)]
  const live = await Promise.all(
    stored.map(async ([, intentId]) => {
      try {
        return (await liveDraftStatus(gate, intentId)) !== null
      } catch {
        return true
      }
    })
  )
  return new Set(stored.filter((_, i) => live[i]).map(([thread]) => thread))
}
