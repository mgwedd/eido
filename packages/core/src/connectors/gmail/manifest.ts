import type { ConnectorManifest, ConnectorOperation } from "@eido/schemas"
import type { GmailConfig } from "./config"
import {
  GMAIL_CONNECTOR,
  GMAIL_HOST,
  GMAIL_PATH_PREFIX,
  GMAIL_SOURCE,
  GOOGLE_OAUTH_HOST,
  READ_PATHS,
  SCOPE_MODIFY,
  SCOPE_READONLY,
  WRITE_PATHS,
} from "./routes"

// The pinned manifest is the only description of this connector that policy reads. What a running
// server says about its own tools, annotations included, is never consulted (see gmailPolicyFor).
//
// Two OAuth clients: reads use the read client (gmail.readonly) through the egress proxy; writes
// use the compose client (gmail.modify) in the executor. Each operation names the one scope its
// client holds, so a read never needs the compose client's token.

type Route = NonNullable<ConnectorOperation["routes"]>[number]
type Op = Pick<
  ConnectorOperation,
  "name" | "effect" | "reversibility" | "defaultTier"
> & { intentKind?: string; routes?: Route[] }

const get = (pathPattern: string): Route => ({
  host: GMAIL_HOST,
  method: "GET",
  pathPattern,
})

const read = (name: string, routes: Route[]): Op => ({
  name,
  effect: "read",
  reversibility: "reversible",
  defaultTier: "auto",
  routes,
})

const write = (
  name: string,
  intentKind: string,
  reversibility: Op["reversibility"],
  defaultTier: Op["defaultTier"],
  routes?: Route[]
): Op => ({
  name,
  effect: "write",
  reversibility,
  defaultTier,
  intentKind,
  ...(routes === undefined ? {} : { routes }),
})

const batchModify: Route = {
  host: GMAIL_HOST,
  method: "POST",
  pathPattern: WRITE_PATHS.batchModify,
}
const messageSend: Route = {
  host: GMAIL_HOST,
  method: "POST",
  pathPattern: WRITE_PATHS.messageSend,
}

// Sync's reads are pinned under the read verb they serve, so the proxy allows only these paths.
const OPERATIONS: readonly Op[] = [
  read("mail_search", [
    get(READ_PATHS.messages),
    get(READ_PATHS.history),
    get(READ_PATHS.profile),
  ]),
  read("mail_thread", [get(READ_PATHS.thread)]),
  read("mail_get", [get(READ_PATHS.message)]),
  // Attachments arrive inside the raw message, so this verb has no route of its own.
  read("attachment_text", []),
  write("draft_create", "email.draft", "reversible", "auto"),
  write("label", "email.label", "reversible", "auto", [batchModify]),
  write("archive", "email.archive", "reversible", "auto", [batchModify]),
  write("mark_read", "email.markRead", "reversible", "auto", [batchModify]),
  write("send", "email.send", "irreversible", "approval"),
  write("reply", "email.reply", "irreversible", "approval", [messageSend]),
  write("forward", "email.forward", "irreversible", "approval", [messageSend]),
  write("trash", "email.trash", "reversible", "approval", [batchModify]),
]

export function gmailManifest(config: GmailConfig): ConnectorManifest {
  return {
    name: GMAIL_CONNECTOR,
    version: 1,
    description:
      "Gmail through the Gmail REST API: core reads through the gate's egress proxy and proposes intents; the gate's executor writes.",
    auth: { type: "oauth2", scopes: [SCOPE_READONLY, SCOPE_MODIFY] },
    egress: {
      hosts: [
        {
          host: GMAIL_HOST,
          methods: ["GET", "POST"],
          pathPrefixes: [GMAIL_PATH_PREFIX],
        },
        {
          host: GOOGLE_OAUTH_HOST,
          methods: ["POST"],
          pathPrefixes: ["/token"],
        },
      ],
    },
    operations: OPERATIONS.map((op) => ({
      ...op,
      // Mail is private to the owner, and message bodies are written by other people.
      sensitivity: "sensitive",
      untrustedOutput: op.effect === "read",
      authScopes: [op.effect === "read" ? SCOPE_READONLY : SCOPE_MODIFY],
    })),
    triggers: config.labels.map((stream) => ({
      kind: "poll",
      stream,
      intervalSeconds: 60,
    })),
    // No ledger in the MVP: the mapping only names where a ledger entry would point.
    ledgerMapping: { source: GMAIL_SOURCE, refField: "source_ref" },
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
export function gmailObservedToolNames(listing: unknown): string[] {
  if (!Array.isArray(listing)) return []
  const tools: unknown[] = listing
  const names: string[] = []
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null || !("name" in tool)) continue
    const name: unknown = tool.name
    if (typeof name === "string") names.push(name)
  }
  return names
}

/** Policy's view of a tool: its pinned operation, or undefined (which policy treats as forbidden). */
export function gmailPolicyFor(
  manifest: ConnectorManifest,
  toolName: string
): ConnectorOperation | undefined {
  return manifest.operations.find((op) => op.name === toolName)
}
