import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import type { KeyObject } from "node:crypto"
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
import type { ApprovalAssertion } from "./approvals"
import { pinManifest, prepareManifestPin } from "./connectors"
import type {
  PreparedControlApproval,
  ControlAuthorization,
} from "./control-approvals"
import { openControlDb } from "./control-db"
import {
  loadPolicy,
  OVERLAY_FILE,
  preparePolicyChange,
  setPolicyOverrides,
} from "./policy"
import type { IntentKind, Policy, PolicyOptions } from "./policy"
import type { Registration } from "./credentials"
import type { WebAuthnConfig } from "./webauthn"

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
  for (const connector of connectors) signedPin(db, connector)
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

// A test WebAuthn authenticator: an ES256 key pair from node:crypto that crafts
// authenticatorData and clientDataJSON byte for byte, so each check can be broken on its own.
// The relying party is a synthetic host; nothing here talks to a browser or network.

export const WEBAUTHN: WebAuthnConfig = {
  rpId: "eido.example.invalid",
  origin: "https://eido.example.invalid",
}

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40
export const FLAGS_UP_UV = FLAG_UP | FLAG_UV

export type TestAuthenticator = {
  credentialId: string
  publicKey: string
  privateKey: KeyObject
}

export function testAuthenticator(): TestAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  })
  return {
    credentialId: randomBytes(16).toString("base64url"),
    publicKey: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    privateKey,
  }
}

const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest()

/**
 * The challenge as the device builds it: SHA-256 over the JSON array of the three strings,
 * written here with JSON.stringify (equal to RFC 8785 for these ASCII strings) rather than the
 * gate's canonicalize, so the test does not reuse the code under test.
 */
export function deviceChallenge(
  payloadHash: string,
  intentId: string,
  nonce: string
): string {
  return digest(JSON.stringify([payloadHash, intentId, nonce])).toString(
    "base64url"
  )
}

export type CeremonyOptions = {
  type?: string
  origin?: string
  crossOrigin?: boolean
  rpId?: string
  flags?: number
  signCount?: number
}

function authenticatorData(
  options: CeremonyOptions,
  defaultFlags: number,
  attested?: Buffer
): Buffer {
  const header = Buffer.alloc(37)
  digest(options.rpId ?? WEBAUTHN.rpId).copy(header, 0)
  header.writeUInt8(options.flags ?? defaultFlags, 32)
  header.writeUInt32BE(options.signCount ?? 0, 33)
  if (attested === undefined) return header
  const length = Buffer.alloc(2)
  length.writeUInt16BE(attested.length)
  // aaguid of zeros, the id, then a stand-in for the COSE key the gate does not read.
  return Buffer.concat([
    header,
    Buffer.alloc(16),
    length,
    attested,
    Buffer.from([0xa0]),
  ])
}

function clientData(
  type: string,
  challenge: string,
  options: CeremonyOptions
): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: options.type ?? type,
      challenge,
      origin: options.origin ?? WEBAUTHN.origin,
      crossOrigin: options.crossOrigin ?? false,
    }),
    "utf8"
  )
}

/** A navigator.credentials.get response over `challenge` (base64url). */
export function assertion(
  auth: TestAuthenticator,
  challenge: string,
  options: CeremonyOptions = {}
): ApprovalAssertion {
  const authData = authenticatorData(options, FLAGS_UP_UV)
  const clientDataJSON = clientData("webauthn.get", challenge, options)
  const signature = sign(
    "sha256",
    Buffer.concat([authData, digest(clientDataJSON)]),
    auth.privateKey
  )
  return {
    credentialId: auth.credentialId,
    authenticatorData: authData.toString("base64url"),
    clientDataJSON: clientDataJSON.toString("base64url"),
    signature: signature.toString("base64url"),
  }
}

/** A real synthetic WebAuthn signature for a prepared control change. */
export function controlAuthorization(
  db: DatabaseSync,
  prepared: PreparedControlApproval
): ControlAuthorization & { credentialId: string } {
  const auth = testAuthenticator()
  db.prepare(
    "INSERT INTO credentials (credential_id, public_key, sign_count, created_at) VALUES (?, ?, 0, ?)"
  ).run(auth.credentialId, auth.publicKey, new Date().toISOString())
  const challenge = digest(
    JSON.stringify([
      "eido.control.v1",
      prepared.purpose,
      prepared.target,
      prepared.id,
      prepared.payloadHash,
      prepared.nonce,
    ])
  ).toString("base64url")
  return {
    config: WEBAUTHN,
    credentialId: auth.credentialId,
    request: {
      id: prepared.id,
      nonce: prepared.nonce,
      assertion: assertion(auth, challenge),
    },
  }
}

export function signedPin(
  db: DatabaseSync,
  connector: ConnectorManifest,
  actor = "owner"
): void {
  const prepared = prepareManifestPin(db, connector)
  const authorization = controlAuthorization(db, prepared)
  try {
    pinManifest(db, connector, actor, authorization)
  } finally {
    db.prepare("DELETE FROM credentials WHERE credential_id = ?").run(
      authorization.credentialId
    )
  }
}

export function signedPolicy(
  db: DatabaseSync,
  value: unknown,
  actor = "owner"
): void {
  const prepared = preparePolicyChange(db, value)
  const authorization = controlAuthorization(db, prepared)
  try {
    setPolicyOverrides(db, value, actor, authorization)
  } finally {
    db.prepare("DELETE FROM credentials WHERE credential_id = ?").run(
      authorization.credentialId
    )
  }
}

/** A navigator.credentials.create response (attestation "none") over `challenge`. */
export function registration(
  auth: TestAuthenticator,
  challenge: string,
  options: CeremonyOptions & { attestedId?: Buffer; algorithm?: number } = {}
): Registration {
  const attested =
    options.attestedId ?? Buffer.from(auth.credentialId, "base64url")
  return {
    credentialId: auth.credentialId,
    clientDataJSON: clientData("webauthn.create", challenge, options).toString(
      "base64url"
    ),
    authenticatorData: authenticatorData(
      options,
      FLAGS_UP_UV | FLAG_AT,
      attested
    ).toString("base64url"),
    publicKey: auth.publicKey,
    publicKeyAlgorithm: options.algorithm ?? -7,
  }
}
