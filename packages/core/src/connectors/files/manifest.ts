import type { ConnectorManifest, ConnectorOperation } from "@eido/schemas"

export function filesManifest(): ConnectorManifest {
  const write = (
    name: string,
    intentKind: string,
    defaultTier: "auto" | "approval"
  ): ConnectorOperation => ({
    name,
    intentKind,
    effect: "write",
    reversibility: "reversible",
    sensitivity: "sensitive",
    authScopes: [],
    untrustedOutput: false,
    defaultTier,
  })
  return {
    name: "files",
    version: 1,
    description:
      "Local file write proposals; the gate executes writes inside approved folders.",
    auth: { type: "none", scopes: [] },
    egress: { hosts: [] },
    operations: [
      write("file_create", "file.create", "auto"),
      write("file_rename", "file.rename", "auto"),
      write("file_move", "file.move", "auto"),
      write("file_delete", "file.delete", "approval"),
    ],
    triggers: [],
    ledgerMapping: { source: "files", refField: "source_ref" },
    health: {
      backoff: { baseMs: 1000, maxMs: 300000, jitter: true },
      breaker: { failureThreshold: 5, halfOpenProbeAfterMs: 60000 },
    },
  }
}
