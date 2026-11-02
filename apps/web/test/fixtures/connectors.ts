// Synthetic fixtures for the Connectors page. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
import type { GateConnectorSettings } from "@eido/schemas"

type Connector = GateConnectorSettings["connectors"][number]

const gmail: Connector = {
  name: "gmail",
  enabled: true,
  pinnedAt: "2026-10-01T09:00:00.000Z",
  scopes: ["https://scopes.example.invalid/mail.read"],
  health: "healthy",
  consecutiveFailures: 0,
  lastSuccessAt: "2026-10-18T11:28:00.000Z",
  manifestHash:
    "3c9a1f0b7d52e8a4c6b1093de5f7a2c84b61d09e3a7f5c2b8d4e6a10f9c7b3e1",
}

const drive: Connector = {
  name: "drive",
  enabled: true,
  pinnedAt: "2026-10-01T09:00:00.000Z",
  scopes: ["https://scopes.example.invalid/files.read"],
  health: "healthy",
  consecutiveFailures: 0,
  manifestHash:
    "a4125f6e0c9b83d1475ea2b6c0f8d93e15a7b4c26d08e9f13a5b7c4d2e6f9a05",
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
  manifestHash:
    "5b22c8e1d4a7093f6b5e2c1a8d0f7e43b9a6c5d2e1f08a7b3c4d9e6f2a1b0c99",
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

/** Disabled by hand: the read response carries no drift detail. */
const driveDisabled: Connector = { ...drive, enabled: false }

/** Disabled by the gate because the tool manifest changed since it was pinned. */
const driveDrifted: Connector = {
  ...drive,
  enabled: false,
  drift: { added: ["drive.move_bulk"], removed: ["drive.save"] },
}

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
  driveDrifted,
  gmail,
  protonCalendarOpen,
  protonMailOpen,
  sharedBridgeOpen,
}
