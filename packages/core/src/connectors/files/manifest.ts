import type { ConnectorManifest, ConnectorOperation } from "@eido/schemas"

export function filesManifest(): ConnectorManifest {
  const read = (name: string): ConnectorOperation => ({
    name,
    effect: "read",
    reversibility: "reversible",
    sensitivity: "sensitive",
    authScopes: [],
    untrustedOutput: true,
    defaultTier: "auto",
  })
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
      "Allowed local folders: untrusted reads and reversible writes through the gate.",
    auth: { type: "none", scopes: [] },
    egress: { hosts: [] },
    operations: [
      read("files_search"),
      read("file_read_text"),
      read("file_read_pdf_text"),
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
