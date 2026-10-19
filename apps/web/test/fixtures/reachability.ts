// Synthetic fixtures for the reachability states. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.cjs).
import type { ProbeOutcome } from "../render-states"

/** What the same-origin health probe returns in each state. */
const reachabilityProbes = {
  reachable: { kind: "response", status: 204 },
  unreachable: { kind: "network-failure" },
  unhealthy: { kind: "response", status: 503 },
} as const satisfies Record<string, ProbeOutcome>

export { reachabilityProbes }
