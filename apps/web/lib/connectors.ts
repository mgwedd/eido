import {
  validateGateConnectorSettings,
  type GateConnectorSettings,
} from "@eido/schemas"

export type Connector = GateConnectorSettings["connectors"][number]
export type Health = Connector["health"]

export const CONNECTORS_URL = "/api/gate/connector-settings"
export const CACHE_KEY = "eido.connectors.v1"

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

export type CachedStatus = { asOf: string; connectors: Connector[] }

type Store = Pick<Storage, "getItem" | "setItem">

function defaultStore(): Store | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * The last successful read, kept so an offline reload still shows the last known status.
 * The service worker never caches this endpoint, so the page keeps its own copy. It holds
 * only what the gate's response holds: no credentials, no payload bodies.
 */
export function readCache(
  store: Store | null = defaultStore()
): CachedStatus | null {
  try {
    const raw = store?.getItem(CACHE_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as { asOf?: unknown; settings?: unknown }
    if (
      typeof stored.asOf !== "string" ||
      Number.isNaN(Date.parse(stored.asOf))
    )
      return null
    const parsed = validateGateConnectorSettings(stored.settings)
    return parsed.ok
      ? { asOf: stored.asOf, connectors: parsed.value.connectors }
      : null
  } catch {
    return null
  }
}

export function writeCache(
  settings: GateConnectorSettings,
  asOf: Date,
  store: Store | null = defaultStore()
): void {
  try {
    store?.setItem(
      CACHE_KEY,
      JSON.stringify({ asOf: asOf.toISOString(), settings })
    )
  } catch {
    // Storage can be full or blocked; the page works without it.
  }
}

export type ConnectorsLoad =
  | { status: "ready"; connectors: Connector[]; asOf: string }
  | { status: "offline"; connectors: Connector[]; asOf: string }
  | { status: "unauthenticated" }
  | { status: "error" }

/**
 * Reads connector status through the gate. A network failure with a cached read is
 * "offline" and shows that read with its as_of time; any other failure is an error.
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
    const asOf = now()
    writeCache(parsed.value, asOf)
    return {
      status: "ready",
      connectors: parsed.value.connectors,
      asOf: asOf.toISOString(),
    }
  } catch (error) {
    // An aborted read is ignored by the caller; a TypeError is fetch's network failure.
    if (!signal.aborted && error instanceof TypeError) {
      const cached = readCache()
      if (cached) return { status: "offline", ...cached }
    }
    return { status: "error" }
  }
}
