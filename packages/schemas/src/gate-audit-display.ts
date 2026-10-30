import type { GateAuditActor } from "./generated/types"

/** The Activity label agreed for each gate audit actor. `executorApproved` is derived by the gate from its signed approval record. */
export function gateAuditDisplayActor(
  actor: GateAuditActor,
  executorApproved = false
): "you" | "auto" | "gate" {
  switch (actor) {
    case "approver":
    case "owner":
      return "you"
    case "executor":
      return executorApproved ? "you" : "auto"
    case "policy":
    case "data-plane":
      return "auto"
    case "system":
    case "gate":
      return "gate"
  }
}
