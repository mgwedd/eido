import type { ConnectorManifest, ConnectorOperation } from "@eido/schemas"
import type { ProtonCalendarConfig } from "./config"
import { validateProtonCalendarConfig } from "./config"

export const CONNECTOR_NAME = "proton-calendar"
export const BRIDGE_SCOPE = "bridge-password"

type Op = Pick<
  ConnectorOperation,
  "name" | "effect" | "reversibility" | "defaultTier" | "intentKind"
>

const write = (
  name: string,
  intentKind: string,
  reversibility: Op["reversibility"],
  defaultTier: Op["defaultTier"]
): Op => ({ name, effect: "write", reversibility, defaultTier, intentKind })

const OPERATIONS: readonly Op[] = [
  write("event_create", "calendar.create", "reversible", "auto"),
  write("event_update", "calendar.edit", "reversible", "auto"),
  write("event_delete", "calendar.delete", "reversible", "auto"),
]

export function protonCalendarManifest(
  rawConfig: ProtonCalendarConfig
): ConnectorManifest {
  const config = validateProtonCalendarConfig(rawConfig)

  return {
    name: CONNECTOR_NAME,
    version: 1,
    description:
      "Proton Calendar via invitations through Proton Bridge SMTP: events are created, updated and cancelled by sending iCalendar invitations from the assistant identity.",
    auth: { type: "password", scopes: [BRIDGE_SCOPE] },
    // Egress is strictly the local Bridge host and SMTP port; no external HTTP egress.
    egress: {
      hosts: [],
      local: [
        {
          protocol: "smtp",
          host: config.bridgeHost,
          port: config.smtpPort,
        },
      ],
    },
    operations: OPERATIONS.map((op) => ({
      ...op,
      sensitivity: "sensitive",
      untrustedOutput: false,
      authScopes: [BRIDGE_SCOPE],
    })),
    // Reads are out of scope for MVP (#72); no triggers until a read path is chosen.
    triggers: [],
    ledgerMapping: { source: "proton-calendar", refField: "event_uid" },
    health: {
      backoff: { baseMs: 1000, maxMs: 300_000, jitter: true },
      breaker: { failureThreshold: 3, halfOpenProbeAfterMs: 60_000 },
    },
  }
}

export function observedToolNames(listing: unknown): string[] {
  if (!Array.isArray(listing)) return []
  const names: string[] = []
  for (const tool of listing as unknown[]) {
    if (typeof tool !== "object" || tool === null) continue
    const name = (tool as { name?: unknown }).name
    if (typeof name === "string") names.push(name)
  }
  return names
}

export function policyFor(
  manifest: ConnectorManifest,
  toolName: string
): ConnectorOperation | undefined {
  return manifest.operations.find((op) => op.name === toolName)
}
