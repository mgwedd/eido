import type { ConnectorManifest, ConnectorOperation } from "@eido/schemas"

export const CONNECTOR_NAME = "things"
export const THINGS_SCOPE = "Things3"

type Op = Pick<
  ConnectorOperation,
  "name" | "effect" | "reversibility" | "defaultTier" | "intentKind"
>

const read = (name: string): Op => ({
  name,
  effect: "read",
  reversibility: "reversible",
  defaultTier: "auto",
})

const write = (
  name: string,
  intentKind: string,
  reversibility: Op["reversibility"],
  defaultTier: Op["defaultTier"]
): Op => ({ name, effect: "write", reversibility, defaultTier, intentKind })

export const THINGS_OPERATIONS: readonly Op[] = [
  read("list_todos"),
  read("get_todo"),
  read("list_deadline"),
  read("list_projects"),
  read("get_project"),
  read("list_areas"),
  read("list_tags"),
  write("add_todo", "things.add_todo", "reversible", "auto"),
  write("update_todo", "things.update_todo", "reversible", "approval"),
  write("schedule_todo", "things.schedule_todo", "reversible", "approval"),
  write("complete_todo", "things.complete_todo", "reversible", "approval"),
  write("cancel_todo", "things.cancel_todo", "reversible", "approval"),
  write("add_project", "things.add_project", "reversible", "approval"),
]

export function thingsManifest(): ConnectorManifest {
  return {
    name: CONNECTOR_NAME,
    version: 1,
    description:
      "Things 3 over macOS AppleScript: task management read and written by the gate; core syncs items and proposes intents.",
    auth: { type: "macos-automation", scopes: [THINGS_SCOPE] },
    egress: {
      hosts: [],
    },
    operations: THINGS_OPERATIONS.map((op) => ({
      ...op,
      sensitivity: "sensitive",
      untrustedOutput: op.effect === "read",
      authScopes: [THINGS_SCOPE],
    })),
    triggers: [
      {
        kind: "poll",
        stream: "todos",
        intervalSeconds: 60,
      },
    ],
    ledgerMapping: { source: "things", refField: "source_ref" },
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
