// Synthetic fixtures for the Connectors page. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.cjs).
import type { GateConnectorSettings } from "@eido/schemas"

type Connector = GateConnectorSettings["connectors"][number]

const gmail: Connector = {
  name: "gmail",
  enabled: true,
  pinnedAt: "2026-10-01T09:00:00.000Z",
  scopes: ["https://scopes.example.invalid/mail.read"],
  health: "healthy",
  consecutiveFailures: 0,
}

const drive: Connector = {
  name: "drive",
  enabled: true,
  pinnedAt: "2026-10-01T09:00:00.000Z",
  scopes: ["https://scopes.example.invalid/files.read"],
  health: "healthy",
  consecutiveFailures: 0,
}

/** Proton Mail and Proton Calendar share Bridge health: both are open together. */
const bridgeOpen = (name: string): Connector => ({
  name,
  enabled: true,
  pinnedAt: "2026-10-03T09:00:00.000Z",
  scopes: [],
  health: "open",
  consecutiveFailures: 3,
  lastError: "bridge_handshake_failed",
  nextAttemptAt: "2026-10-18T10:14:00.000Z",
})

const protonMailOpen = bridgeOpen("proton-mail")
const protonCalendarOpen = bridgeOpen("proton-calendar")

const driveDegraded: Connector = {
  ...drive,
  health: "degraded",
  consecutiveFailures: 1,
  lastError: "upstream_timeout",
  nextAttemptAt: "2026-10-18T12:05:00.000Z",
}

/** Disabled by the gate; the read response carries no drift detail. */
const driveDisabled: Connector = { ...drive, enabled: false }

const sharedBridgeOpen: GateConnectorSettings["connectors"] = [
  gmail,
  protonMailOpen,
  protonCalendarOpen,
  drive,
]

const AS_OF = "2026-10-18T11:30:00.000Z"

export {
  AS_OF,
  drive,
  driveDegraded,
  driveDisabled,
  gmail,
  protonCalendarOpen,
  protonMailOpen,
  sharedBridgeOpen,
}
