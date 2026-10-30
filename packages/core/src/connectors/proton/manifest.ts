import type { ConnectorManifest, ConnectorOperation } from "@eido/schemas"
import type { ProtonConfig } from "./config"

// The pinned manifest is the only description of this connector that policy reads. What a running
// server says about its own tools, annotations included, is never consulted (see policyFor).

export const CONNECTOR_NAME = "proton-mail"
export const BRIDGE_SCOPE = "bridge-password"

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

const OPERATIONS: readonly Op[] = [
  read("mail_search"),
  read("mail_thread"),
  read("mail_get"),
  read("attachment_text"),
  write("draft_create", "email.draft", "reversible", "auto"),
  write("send", "email.send", "irreversible", "approval"),
  write("reply", "email.reply", "irreversible", "approval"),
  write("forward", "email.forward", "irreversible", "approval"),
  write("trash", "email.trash", "reversible", "approval"),
]

export function protonManifest(config: ProtonConfig): ConnectorManifest {
  return {
    name: CONNECTOR_NAME,
    version: 1,
    description:
      "Proton Mail through Proton Bridge: mail is read and written by the gate; core indexes it and proposes intents as the assistant identity.",
    auth: { type: "password", scopes: [BRIDGE_SCOPE] },
    // Bridge is reached only by the gate; the local declaration pins its two TCP endpoints.
    egress: {
      hosts: [],
      local: [
        { protocol: "imap", host: "127.0.0.1", port: 1143 },
        { protocol: "smtp", host: "127.0.0.1", port: 1025 },
      ],
    },
    operations: OPERATIONS.map((op) => ({
      ...op,
      // Mail is private to the owner, and message bodies are written by other people.
      sensitivity: "sensitive",
      untrustedOutput: op.effect === "read",
      authScopes: [BRIDGE_SCOPE],
    })),
    triggers: config.folders.map((stream) => ({
      kind: "poll",
      stream,
      intervalSeconds: 60,
    })),
    ledgerMapping: { source: "proton", refField: "message_id" },
    health: {
      backoff: { baseMs: 1000, maxMs: 300_000, jitter: true },
      breaker: { failureThreshold: 3, halfOpenProbeAfterMs: 60_000 },
    },
  }
}

/**
 * Tool names from a server's tool listing. Only `name` is read: annotations (readOnlyHint and the
 * like) are the server's claims about itself and play no part in policy.
 */
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

/** Policy's view of a tool: its pinned operation, or undefined (which policy treats as forbidden). */
export function policyFor(
  manifest: ConnectorManifest,
  toolName: string
): ConnectorOperation | undefined {
  return manifest.operations.find((op) => op.name === toolName)
}
