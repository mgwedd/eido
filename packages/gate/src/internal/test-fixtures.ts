import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { validateIntent } from "@eido/schemas"
import type {
  ConnectorManifest,
  ConnectorOperation,
  Intent,
} from "@eido/schemas"
import { pinManifest } from "./connectors"
import { openControlDb } from "./control-db"
import { loadPolicy, OVERLAY_FILE } from "./policy"
import type { IntentKind, Policy, PolicyOptions } from "./policy"

// Test-only fixtures for the policy and intent tests: synthetic connectors (example.com hosts,
// made-up scopes) and one synthetic payload per verb. No real addresses, ids or tokens.

export const OWNER = "owner@example.com"
export const ALLOWED_ROOT = "notes"
// A marker no audit or history field may ever contain: it appears only in payload bodies.
export const BODY_MARKER = "lorem-ipsum-body-7f3a"

type Op = Pick<
  ConnectorOperation,
  "name" | "intentKind" | "reversibility" | "defaultTier"
>

function op(
  name: string,
  intentKind: IntentKind,
  reversibility: ConnectorOperation["reversibility"],
  defaultTier: ConnectorOperation["defaultTier"]
): Op {
  return { name, intentKind, reversibility, defaultTier }
}

export function manifest(
  name: string,
  operations: readonly Op[],
  version = 1
): ConnectorManifest {
  return {
    name,
    version,
    description: `Synthetic ${name} connector for tests`,
    auth: { type: "oauth2", scopes: ["write"] },
    egress: {
      hosts: [
        {
          host: `${name}.example.com`,
          methods: ["POST"],
          pathPrefixes: ["/v1"],
        },
      ],
    },
    operations: operations.map((entry) => ({
      ...entry,
      effect: "write",
      sensitivity: "normal",
      untrustedOutput: false,
      authScopes: ["write"],
    })),
    triggers: [],
    ledgerMapping: { source: name, refField: "id" },
    health: {
      backoff: { baseMs: 500, maxMs: 60000, jitter: true },
      breaker: { failureThreshold: 3, halfOpenProbeAfterMs: 30000 },
    },
  }
}

export const MAIL_OPS: readonly Op[] = [
  op("save_draft", "email.draft", "reversible", "auto"),
  op("set_labels", "email.label", "reversible", "auto"),
  op("archive", "email.archive", "reversible", "auto"),
  op("mark_read", "email.markRead", "reversible", "auto"),
  op("send", "email.send", "irreversible", "approval"),
  op("reply", "email.reply", "irreversible", "approval"),
  op("forward", "email.forward", "irreversible", "approval"),
  op("trash", "email.trash", "reversible", "approval"),
]

export const CALENDAR_OPS: readonly Op[] = [
  op("create_event", "calendar.create", "reversible", "auto"),
  op("edit_event", "calendar.edit", "reversible", "auto"),
  op("cancel_event", "calendar.delete", "reversible", "auto"),
]

export const FILE_OPS: readonly Op[] = [
  op("create_file", "file.create", "reversible", "auto"),
  op("rename_file", "file.rename", "reversible", "auto"),
  op("move_file", "file.move", "reversible", "auto"),
  op("trash_file", "file.delete", "reversible", "approval"),
]

const ARGS = {
  "email.draft": {
    to: ["someone@example.com"],
    subject: "Hello",
    body: BODY_MARKER,
  },
  "email.label": { messageIds: ["msg-1"], add: ["work"] },
  "email.archive": { messageIds: ["msg-1"] },
  "email.markRead": { messageIds: ["msg-1"], read: true },
  "email.send": {
    to: ["someone@example.com"],
    subject: "Hello",
    body: BODY_MARKER,
  },
  "email.reply": { messageId: "msg-1", replyAll: false, body: BODY_MARKER },
  "email.forward": { messageId: "msg-1", to: ["someone@example.com"] },
  "email.trash": { messageIds: ["msg-1"] },
  "calendar.create": {
    entity: "personal",
    title: BODY_MARKER,
    start: "2026-10-20T09:00:00Z",
    end: "2026-10-20T10:00:00Z",
    allDay: false,
  },
  "calendar.edit": { eventUid: "evt-1", title: BODY_MARKER },
  "calendar.delete": { eventUid: "evt-1" },
  "reminder.create": { list: "Inbox", title: BODY_MARKER },
  "file.create": { root: ALLOWED_ROOT, path: "a.txt", content: BODY_MARKER },
  "file.rename": { root: ALLOWED_ROOT, path: "a.txt", newName: "b.txt" },
  "file.move": { root: ALLOWED_ROOT, path: "a.txt", toPath: "old/a.txt" },
  "file.delete": { root: ALLOWED_ROOT, path: "a.txt" },
} satisfies { [K in IntentKind]: Extract<Intent, { kind: K }>["args"] }

/** A valid intent of `kind`, with `args` overriding the sample args; parsed, not cast. */
export function sample(
  kind: IntentKind,
  args: Readonly<Record<string, unknown>> = {}
): Intent {
  const result = validateIntent({ kind, args: { ...ARGS[kind], ...args } })
  if (!result.ok) {
    throw new Error(`fixture ${kind} is invalid: ${result.errors.join("; ")}`)
  }
  return result.value
}

export type Setup = {
  db: DatabaseSync
  dataDir: string
  options: PolicyOptions
  policy: Policy
  writeOverlay: (value: unknown) => void
  cleanup: () => void
}

/** A control DB with the mail, calendar and files fixtures pinned, and the policy loaded. */
export function setup(
  connectors: readonly ConnectorManifest[] = [
    manifest("mail", MAIL_OPS),
    manifest("calendar", CALENDAR_OPS),
    manifest("files", FILE_OPS),
  ]
): Setup {
  const dataDir = mkdtempSync(join(tmpdir(), "eido-gate-"))
  const db = openControlDb(":memory:")
  for (const connector of connectors) pinManifest(db, connector, "owner")
  const options: PolicyOptions = {
    dataDir,
    ownerAddresses: [OWNER],
    allowedRoots: [ALLOWED_ROOT],
  }
  return {
    db,
    dataDir,
    options,
    policy: loadPolicy(db, options).policy,
    writeOverlay: (value) =>
      writeFileSync(
        join(dataDir, OVERLAY_FILE),
        typeof value === "string" ? value : JSON.stringify(value),
        { mode: 0o600 }
      ),
    cleanup: () => {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

export type AuditRow = {
  seq: number
  actor: string
  action: string
  target: string
  detail_hash: string
}

export function auditRows(db: DatabaseSync): AuditRow[] {
  return db
    .prepare(
      "SELECT seq, actor, action, target, detail_hash FROM audit_log ORDER BY seq"
    )
    .all()
    .map((row) => ({
      seq: Number(row["seq"]),
      actor: String(row["actor"]),
      action: String(row["action"]),
      target: String(row["target"]),
      detail_hash: String(row["detail_hash"]),
    }))
}

/** Every column of every audit_log and intent_events row, as one string. */
export function loggedText(db: DatabaseSync): string {
  const audit = db.prepare("SELECT * FROM audit_log").all()
  const events = db.prepare("SELECT * FROM intent_events").all()
  return JSON.stringify([audit, events])
}
