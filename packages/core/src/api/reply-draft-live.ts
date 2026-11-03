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
