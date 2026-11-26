import type { DatabaseSync } from "node:sqlite"
import type { GateControlStatus } from "@eido/schemas"
import { controlStatus } from "./control-checkpoint"
import type { Reply } from "./http"

/**
 * GET /audit/control (#916): whether the control checkpoint is enforced and why the gate
 * denies authority reads right now, as the enum and nothing else. It reads only the in-process
 * checkpoint state and the control database snapshot, never the policy or the keychain, so it
 * answers while the gate is denied or started locked.
 */
export function controlStatusRoute(db: DatabaseSync): Reply {
  const status = controlStatus(db)
  const body: GateControlStatus = status.enforced
    ? { enforced: true, denied: status.denied ?? null }
    : { enforced: false }
  return { status: 200, body }
}
