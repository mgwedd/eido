import type { ConnectorManifest, ConnectorOperation } from "@eido/schemas"
const SCOPE = "https://www.googleapis.com/auth/drive.readonly"
const route = (pathPattern: string) => ({
  host: "www.googleapis.com",
  method: "GET" as const,
  pathPattern: `/drive/v3/${pathPattern}`,
})
export function driveManifest(): ConnectorManifest {
  const read = (name: string, paths: string[]): ConnectorOperation => ({
    name,
    effect: "read",
    reversibility: "reversible",
    sensitivity: "sensitive",
    untrustedOutput: true,
    authScopes: [SCOPE],
    defaultTier: "auto",
    routes: paths.map(route),
  })
  return {
    name: "drive",
    version: 1,
    description:
      "Read-only Google Drive, through the gate's OAuth egress proxy.",
    auth: { type: "oauth2", scopes: [SCOPE] },
    egress: {
      hosts: [
        {
          host: "www.googleapis.com",
          methods: ["GET"],
          pathPrefixes: ["/drive/v3"],
        },
      ],
    },
    operations: [
      read("drive_list_files", ["files", "changes", "changes/startPageToken"]),
      read("drive_search_files", ["files"]),
      read("drive_get_file_text", ["files/{id}", "files/{id}/export"]),
    ],
    triggers: [{ kind: "poll", stream: "files", intervalSeconds: 60 }],
    ledgerMapping: { source: "drive", refField: "source_ref" },
    health: {
      backoff: { baseMs: 1000, maxMs: 300000, jitter: true },
      breaker: { failureThreshold: 5, halfOpenProbeAfterMs: 60000 },
    },
  }
}
