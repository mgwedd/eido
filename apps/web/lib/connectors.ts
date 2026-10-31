import {
  validateGateConnectorSettings,
  type GateConnectorSettings,
} from "@eido/schemas"

export type Connector = GateConnectorSettings["connectors"][number]
export type Health = Connector["health"]

export const CONNECTORS_URL = "/api/gate/connector-settings"

/** Display names for the connectors the gate pins today; any other name is shown as sent. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  gmail: "Gmail",
  "proton-mail": "Proton Mail (Bridge)",
  "proton-calendar": "Proton Calendar (invitations via Bridge)",
  drive: "Drive",
}

/** Proton Mail and Proton Calendar both go through Proton Bridge, so they share its health. */
const BRIDGE_CONNECTORS: readonly string[] = ["proton-mail", "proton-calendar"]

export function displayName(name: string): string {
  return DISPLAY_NAMES[name] ?? name
}

export function healthLabel(connector: Connector): string {
  if (!connector.enabled) return "Disabled"
  return { healthy: "Healthy", degraded: "Degraded", open: "Open" }[
    connector.health
  ]
}

/** The breaker follows the gate's health: healthy is closed, degraded backs off, open refuses reads. */
export function breakerLabel(health: Health): string {
  return { healthy: "Closed", degraded: "Backing off", open: "Open" }[health]
}

/** "Oct 18, 2026" in the viewer's locale and time zone. */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(iso)
  )
}

/** "Oct 18, 2026, 10:14 AM" in the viewer's locale and time zone. */
export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso))
}

export type BridgeNotice = {
  /** Heading sentence, for example "Proton Bridge is paused." */
  title: string
  detail: string
}

/**
 * The shared Bridge notice: shown when any connector that reads through Bridge is not
 * healthy. It names Proton Calendar only when the gate reports a calendar row.
 */
export function bridgeNotice(
  connectors: readonly Connector[]
): BridgeNotice | null {
  const bridge = connectors.filter(
    (c) => c.enabled && BRIDGE_CONNECTORS.includes(c.name)
  )
  if (!bridge.some((c) => c.health !== "healthy")) return null
  const hasCalendar = bridge.some((c) => c.name === "proton-calendar")
  return {
    title: "Proton Bridge is paused.",
    detail: hasCalendar
      ? "Proton Mail and Proton Calendar invitations wait."
      : "Proton Mail waits.",
  }
}

/** True for the calendar row while Bridge is not healthy: invitations wait. */
export function invitationsWait(connector: Connector): boolean {
  return (
    connector.enabled &&
    connector.name === "proton-calendar" &&
    connector.health !== "healthy"
  )
}

export type ConnectorsLoad =
  | { status: "ready"; connectors: Connector[]; asOf: string }
  | { status: "offline" }
  | { status: "unauthenticated" }
  | { status: "error" }

/**
 * Reads connector status through the gate. The response is never stored on the device
 * (`connector-settings` is sensitive): a network failure is "offline" and carries no data;
 * any other failure is an error.
 */
export async function loadConnectors(
  signal: AbortSignal,
  now: () => Date = () => new Date()
): Promise<ConnectorsLoad> {
  try {
    const response = await fetch(CONNECTORS_URL, { cache: "no-store", signal })
    if (response.status === 401) return { status: "unauthenticated" }
    if (!response.ok) return { status: "error" }
    const parsed = validateGateConnectorSettings(await response.json())
    if (!parsed.ok) return { status: "error" }
    return {
      status: "ready",
      connectors: parsed.value.connectors,
      asOf: now().toISOString(),
    }
  } catch (error) {
    // An aborted read is ignored by the caller; a TypeError is fetch's network failure.
    if (!signal.aborted && error instanceof TypeError)
      return { status: "offline" }
    return { status: "error" }
  }
}
