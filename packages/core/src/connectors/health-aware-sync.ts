import type { GateConnectorHealth } from "@eido/schemas"
import { connectorProbeDue } from "./health"
import type { ConnectorHealthState } from "./health"

/** Read-only view of gate-owned connector state. Core never opens the control database. */
export type ConnectorHealthReader = {
  getConnectorHealth: () => Promise<GateConnectorHealth["connectors"]>
}

export type HealthAwareSyncResult<T> =
  { status: "skipped" } | { status: "synced"; result: T }

export type HealthAwareSyncRunner = <T>(
  name: string,
  sync: () => Promise<T>
) => Promise<HealthAwareSyncResult<T>>

/**
 * Wraps sync callbacks with a gate health check. Open connectors wait until their persisted retry
 * deadline; once due, their first real upstream read is the gate's atomic half-open probe. A
 * per-connector in-flight set prevents overlapping jobs without blocking other connectors.
 */
export function createHealthAwareSync(
  gate: ConnectorHealthReader,
  now: () => number = Date.now
): HealthAwareSyncRunner {
  const inFlight = new Set<string>()
  return async <T>(
    name: string,
    sync: () => Promise<T>
  ): Promise<HealthAwareSyncResult<T>> => {
    if (inFlight.has(name)) return { status: "skipped" }
    inFlight.add(name)
    try {
      const record = (await gate.getConnectorHealth()).find(
        (connector) => connector.name === name
      )
      const state: ConnectorHealthState =
        record === undefined
          ? { health: "healthy", consecutiveFailures: 0 }
          : {
              health: record.health,
              consecutiveFailures: record.consecutiveFailures,
              ...(record.nextAttemptAt === undefined
                ? {}
                : { nextAttemptAt: Date.parse(record.nextAttemptAt) }),
              ...(record.lastError === undefined
                ? {}
                : { lastError: record.lastError }),
            }
      if (!connectorProbeDue(state, now())) return { status: "skipped" }
      return { status: "synced", result: await sync() }
    } finally {
      inFlight.delete(name)
    }
  }
}

const runners = new WeakMap<ConnectorHealthReader, HealthAwareSyncRunner>()

/** A shared per-gate runner used by the connector convenience wrappers. */
export function healthAwareSyncRunner(
  gate: ConnectorHealthReader
): HealthAwareSyncRunner {
  let runner = runners.get(gate)
  if (runner === undefined) {
    runner = createHealthAwareSync(gate)
    runners.set(gate, runner)
  }
  return runner
}
