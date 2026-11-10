import { displayName, disabledByDrift, type Connector } from "@/lib/connectors"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export type ConnectorDot = "healthy" | "degraded" | "open" | "disabled"

export type ConnectorRow = {
  name: string
  dot: ConnectorDot
  /** The status in words, so health is never conveyed by colour alone. */
  status: string
  /** The secondary text: last sync, breaker detail or the disabled reason. */
  detail: string
}

/** The largest whole unit of a span: "less than a minute", "4 min", "22 h", "2 d". */
function span(ms: number): string {
  if (ms < MINUTE_MS) return "less than a minute"
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min`
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} h`
  return `${Math.floor(ms / DAY_MS)} d`
}

/** "Synced 4 min ago". */
export function formatSynced(iso: string, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - new Date(iso).getTime())
  return elapsed < MINUTE_MS ? "Synced just now" : `Synced ${span(elapsed)} ago`
}

/** "Probe in 12 min", or "Probe due" once the gate's next attempt time has passed. */
export function formatProbe(iso: string, now: Date): string {
  const remaining = new Date(iso).getTime() - now.getTime()
  return remaining <= 0 ? "Probe due" : `Probe in ${span(remaining)}`
}

function failures(count: number): string {
  return `${count} failed ${count === 1 ? "handshake" : "handshakes"}`
}

function joinParts(parts: (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(" · ")
}

/** One Connectors row from the gate's connector state; text is composed from its fields only. */
export function connectorRow(connector: Connector, now: Date): ConnectorRow {
  const name = displayName(connector.name)
  if (!connector.enabled)
    return {
      name,
      dot: "disabled",
      status: "Disabled",
      detail: disabledByDrift(connector)
        ? "Disabled: tool list changed, re-review"
        : "Disabled: pin it again to resume reads",
    }
  const probe = connector.nextAttemptAt
    ? formatProbe(connector.nextAttemptAt, now)
    : null
  if (connector.health === "open")
    return {
      name,
      dot: "open",
      status: "Open",
      detail: joinParts([
        `Breaker open after ${failures(connector.consecutiveFailures)}`,
        probe,
      ]),
    }
  if (connector.health === "degraded")
    return {
      name,
      dot: "degraded",
      status: "Degraded",
      detail: joinParts([
        `Backing off after ${failures(connector.consecutiveFailures)}`,
        probe,
      ]),
    }
  return {
    name,
    dot: "healthy",
    status: "Healthy",
    detail: connector.lastSuccessAt
      ? formatSynced(connector.lastSuccessAt, now)
      : "Not synced yet",
  }
}

/** "4 manifests pinned · 1 breaker open"; counts come from the rows the gate sent. */
export function connectorSummary(connectors: readonly Connector[]): string {
  const open = connectors.filter((c) => c.enabled && c.health === "open").length
  const pinned = `${connectors.length} ${connectors.length === 1 ? "manifest" : "manifests"} pinned`
  return `${pinned} · ${open} ${open === 1 ? "breaker" : "breakers"} open`
}
