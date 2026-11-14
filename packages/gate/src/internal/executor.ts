import type { DatabaseSync } from "node:sqlite"
import {
  validateIntent,
  validateGateFileHelperRequest,
  validateGateFileRoots,
} from "@eido/schemas"
import type { Intent, GateFileHelperRequest } from "@eido/schemas"
import { randomUUID } from "node:crypto"
import type { FileHelper } from "./files/file-helper"
import { approvedFileRoot } from "./files/file-roots"
import { createFile, moveFile, trashFile } from "./files/file-ops"
import { append } from "./audit"
import { PROTON_CALENDAR_CONNECTOR, PROTON_CONNECTOR } from "./bridge/config"
import { canonicalize, payloadHash } from "./canonical"
import {
  getPinnedManifest,
  intentBindings,
  pinnedOperation,
} from "./connectors"
import { atomically } from "./transaction"
import { appleDestination } from "./apple/destinations"
import { APPLE_CONNECTOR } from "./apple/apple-routes"

/** Provider representation before the gate takes an immutable canonical snapshot. */
export type UpstreamRequest = { method: string; url: string; body: unknown }
export type WriteRequest = Readonly<{
  method: string
  url: string
  body: string
  connector: string
  operation: string
  intentKind: Intent["kind"]
  idempotencyKey: string
}>
export type UpstreamResult = { upstreamRef: string | null; result: unknown }

/** Gate-trusted adapters, registered at startup; never loaded from connector/model output. */
export interface UpstreamWriter {
  kind: Intent["kind"]
  /** Gate-owned adapter identity; never selected by kind alone. */
  connector: string
  buildRequest(
    this: void,
    intent: Intent
  ): UpstreamRequest | Promise<UpstreamRequest>
  /** Reconstruct all intent semantics from the exact method, URL and canonical body. */
  intentFromRequest(
    this: void,
    request: Readonly<UpstreamRequest>,
    connector?: string
  ): unknown
  inverse(this: void, intent: Intent, result: unknown): unknown
  /**
   * "bridge": the request goes to Proton Bridge through the gate's own IMAP and SMTP adapter
   * (#195), not over HTTPS, so its destination is one of BRIDGE_DESTINATIONS, not a pinned route.
   * "eventkit": only the apple-eventkit connector's four fixed native destinations; no network egress.
   */
  channel?: "bridge" | "eventkit"
}

/**
 * The one destination each Bridge intent kind may name. The URL is a label for the adapter call,
 * not an address: the transport sends it to the configured loopback Bridge only.
 */
export const BRIDGE_DESTINATIONS = {
  "email.draft": "bridge:imap/append-draft",
  "email.send": "bridge:smtp/send",
  "email.reply": "bridge:smtp/send",
  "email.forward": "bridge:smtp/send",
  "email.trash": "bridge:imap/move-to-trash",
  "calendar.create": "bridge:smtp/send",
  "calendar.edit": "bridge:smtp/send",
  "calendar.delete": "bridge:smtp/send",
} as const satisfies Partial<Record<Intent["kind"], string>>

/** The Bridge destination for `kind`, or undefined when Bridge does not run that kind. */
export function bridgeDestinationFor(kind: string): string | undefined {
  return Object.entries(BRIDGE_DESTINATIONS).find(
    ([entry]) => entry === kind
  )?.[1]
}

/** Gate-internal credential-backed transport, separate from the read-only HTTP proxy. */
export type WriteTransport = (request: WriteRequest) => Promise<UpstreamResult>
export type ExecutionResult =
  | { ok: true; upstreamRef: string | null; result: unknown }
  | { ok: false; code: string }

type Direction = "execute" | "undo"
type Stored = {
  kind: string
  json: string
  hash: string
  tier: string
  state: string
}
type Ready = {
  connector: string
  operation: string
  intent: Intent
  writer: UpstreamWriter
  stored: Stored
}

type Prepared = {
  intent: Intent
  writer: UpstreamWriter
  request: WriteRequest
  stored: Stored
}

function readIntent(db: DatabaseSync, id: string): Stored | undefined {
  const row = db.prepare("SELECT * FROM intents WHERE id = ?").get(id)
  if (row === undefined) return undefined
  return {
    kind: String(row["kind"]),
    json: String(row["payload_json"]),
    hash: String(row["payload_hash"]),
    tier: String(row["tier"]),
    state: String(row["state"]),
  }
}

function parse(text: string): unknown {
  return JSON.parse(text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function checkedIntent(value: unknown, expectedHash: string): Intent {
  const checked = validateIntent(value)
  if (!checked.ok || payloadHash(checked.value) !== expectedHash) {
    throw new Error("hash_mismatch")
  }
  return checked.value
}

function auditEvent(
  db: DatabaseSync,
  id: string,
  action: string,
  detail: unknown,
  state?: { from: string; to: string; reason: string | null }
): number {
  const { seq } = append(db, {
    actor: "executor",
    action,
    target: id,
    detailHash: payloadHash(detail),
  })
  if (state !== undefined) {
    db.prepare(
      "INSERT INTO intent_events (audit_seq, intent_id, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?)"
    ).run(seq, id, state.from, state.to, state.reason)
  }
  return seq
}

/** Bind successful records to their append-only audit row before returning or undoing them. */
function recorded(
  db: DatabaseSync,
  id: string,
  direction: Direction
): { value: UpstreamResult; inverse: unknown } | undefined {
  const sql =
    direction === "execute"
      ? `SELECT e.*, a.detail_hash, a.action, a.target FROM executions e JOIN audit_log a ON a.seq=e.audit_seq WHERE e.intent_id=?`
      : `SELECT u.*, e.inverse_op, a.detail_hash, a.action, a.target FROM execution_undos u JOIN executions e ON e.intent_id=u.intent_id JOIN audit_log a ON a.seq=u.audit_seq WHERE u.intent_id=?`
  const row = db.prepare(sql).get(id)
  if (row === undefined) return undefined
  const result = parse(String(row["result"]))
  const inverse =
    row["inverse_op"] === null ? null : parse(String(row["inverse_op"]))
  const upstreamRef =
    row["upstream_ref"] === null ? null : String(row["upstream_ref"])
  if (
    row["action"] !== direction ||
    row["target"] !== id ||
    row["detail_hash"] !==
      payloadHash({ upstream_ref: upstreamRef, result, inverse })
  )
    throw new Error("record_mismatch")
  return { value: { upstreamRef, result }, inverse }
}

/** The authenticated successful execution receipt used to derive a fresh restore proposal. */
export function executionReceipt(
  db: DatabaseSync,
  id: string
): UpstreamResult | undefined {
  try {
    return recorded(db, id, "execute")?.value
  } catch {
    return undefined
  }
}

/** Rebuild the destination from a pinned write route, never from an unvalidated authority. */
function writeDestination(
  db: DatabaseSync,
  connector: string,
  operationName: string,
  request: UpstreamRequest
): string {
  const raw = request.url
  if (!/^https:\/\//.test(raw) || /[\\\s]/.test(raw))
    throw new Error("invalid target")
  const url = new URL(raw)
  if (url.username || url.password || url.port || url.hash)
    throw new Error("invalid target")
  const rawPath = /^https:\/\/[^/?#]+([^?#]*)/.exec(raw)?.[1] ?? "/"
  if (/%(?:2f|5c|25)/i.test(rawPath)) throw new Error("invalid path")
  const path = decodeURIComponent(rawPath)
  if (
    path.split("/").some((part) => part === "." || part === "..") ||
    path.includes("//")
  )
    throw new Error("invalid path")
  const manifest = getPinnedManifest(db, connector)
  const host = manifest?.egress.hosts.find(
    (entry) => entry.host === url.hostname
  )
  if (
    host === undefined ||
    !host.methods.some((method) => method === request.method) ||
    !host.pathPrefixes.some(
      (prefix) =>
        path === prefix ||
        path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
    )
  )
    throw new Error("unpinned host route")
  const parts = path.split("/")
  const matching = (manifest?.operations ?? []).flatMap((operation) =>
    (operation.routes ?? [])
      .filter((route) => {
        const template = route.pathPattern.split("/")
        return (
          route.host === host.host &&
          route.method === request.method &&
          template.length === parts.length &&
          template.every((part, index) =>
            /^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(part)
              ? parts[index] !== ""
              : parts[index] === part
          )
        )
      })
      .map((route) => ({ operation, route }))
  )
  // Several write operations may share one route: Gmail's batchModify carries mark read, label,
  // archive and trash, and the writer's strict decoder tells them apart. The intent's own
  // operation must pin the route exactly once, and a read operation sharing it is refused.
  const own = matching.filter(
    (candidate) => candidate.operation.name === operationName
  )
  const selected = own.length === 1 ? own[0] : undefined
  if (
    selected === undefined ||
    !matching.every((candidate) => candidate.operation.effect === "write")
  )
    throw new Error("unpinned write route")
  const safePath = selected.route.pathPattern
    .split("/")
    .map((part, index) =>
      /^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(part)
        ? encodeURIComponent(parts[index] ?? "")
        : part
    )
    .join("/")
  const destination = new URL(`https://${selected.route.host}${safePath}`)
  // Preserve query semantics, but construct their bytes through URLSearchParams.
  for (const [key, value] of url.searchParams)
    destination.searchParams.append(key, value)
  return destination.href
}

/**
 * Bridge writes run only for the Proton connector whose pinned manifest uses a password and
 * declares no HTTP egress (Bridge is a local IMAP and SMTP service). A connector that fails this
 * is misconfigured, which is refused on its own code rather than reported as tampering.
 */
function bridgeConfigured(db: DatabaseSync, connector: string): boolean {
  const manifest = getPinnedManifest(db, connector)
  return (
    (connector === PROTON_CONNECTOR ||
      connector === PROTON_CALENDAR_CONNECTOR) &&
    manifest?.auth.type === "password" &&
    manifest.egress.hosts.length === 0
  )
}

/** The one destination of a Bridge intent kind; any other request is not the approved one. */
function bridgeDestination(
  kind: Intent["kind"],
  request: UpstreamRequest
): string {
  const destination = bridgeDestinationFor(kind)
  if (
    destination === undefined ||
    request.method !== "POST" ||
    request.url !== destination
  )
    throw new Error("unpinned bridge route")
  return destination
}

function eventkitConfigured(db: DatabaseSync, connector: string): boolean {
  const manifest = getPinnedManifest(db, connector)
  return (
    connector === APPLE_CONNECTOR &&
    manifest?.auth.type === "macos-eventkit" &&
    manifest.egress.hosts.length === 0 &&
    (manifest.egress.local?.length ?? 0) === 0
  )
}

function eventkitDestination(
  kind: Intent["kind"],
  operation: string,
  request: UpstreamRequest
): string {
  const destination = appleDestination(kind)
  if (
    destination === undefined ||
    request.method !== "POST" ||
    request.url !== destination ||
    destination !== `eventkit:${operation}`
  ) {
    throw new Error("unpinned EventKit route")
  }
  return destination
}

export function createExecutor(
  db: DatabaseSync,
  writers: readonly UpstreamWriter[],
  transport: WriteTransport,
  files?: FileHelper
): {
  execute(id: string): Promise<ExecutionResult>
  undo(id: string): Promise<ExecutionResult>
} {
  const registry = new Map<string, UpstreamWriter>()
  const writerKey = (kind: string, connector: string) => `${connector}:${kind}`
  for (const writer of writers) {
    const key = writerKey(writer.kind, writer.connector)
    if (registry.has(key)) throw new Error("duplicate writer kind")
    registry.set(key, writer)
  }

  const refuse = (
    id: string,
    direction: Direction,
    code: string
  ): ExecutionResult => {
    auditEvent(db, id, `${direction}.refused.${code}`, { reason: code })
    return { ok: false, code }
  }

  const fail = (
    id: string,
    direction: Direction,
    code: string
  ): ExecutionResult =>
    atomically(db, () => {
      const stored = readIntent(db, id)
      if (direction === "execute" && stored !== undefined) {
        db.prepare(
          "UPDATE intents SET state='failed' WHERE id=? AND state IN ('approved','proposed')"
        ).run(id)
      }
      auditEvent(
        db,
        id,
        code === "hash_mismatch"
          ? "alert.hash_mismatch"
          : `${direction}.failed.${code}`,
        { reason: code },
        stored === undefined
          ? undefined
          : {
              from: stored.state,
              to:
                direction === "execute" &&
                ["approved", "proposed"].includes(stored.state)
                  ? "failed"
                  : stored.state,
              reason: code,
            }
      )
      return { ok: false, code }
    })

  function prepare(id: string, direction: Direction): Ready | ExecutionResult {
    const stored = readIntent(db, id)
    if (stored === undefined) return refuse(id, direction, "not_found")
    if (direction === "execute") {
      if (
        stored.tier === "forbidden" ||
        !(
          stored.state === "approved" ||
          (stored.state === "proposed" && stored.tier === "auto")
        )
      ) {
        return refuse(id, direction, "invalid_state")
      }
    } else if (stored.state !== "executed" || stored.tier !== "auto") {
      return refuse(id, direction, "undo_not_allowed")
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM execution_attempts WHERE intent_id=? AND direction=?"
        )
        .get(id, direction) !== undefined
    )
      return refuse(id, direction, "outcome_unresolved")
    let intent: Intent
    try {
      intent = checkedIntent(parse(stored.json), stored.hash)
      if (stored.kind !== intent.kind || canonicalize(intent) !== stored.json)
        throw new Error("hash_mismatch")
    } catch {
      return fail(id, direction, "hash_mismatch")
    }
    if (
      direction === "execute" &&
      (intent.kind === "email.untrash" || intent.kind.startsWith("apple.")) &&
      stored.tier !== "approval"
    )
      return refuse(id, direction, "invalid_state")
    if (direction === "execute" && stored.tier === "approval") {
      const approval = db
        .prepare(
          `SELECT a.bundle_hash FROM approvals a
         JOIN approval_nonces n ON n.nonce=a.nonce AND n.intent_id=a.intent_id
         JOIN credentials c ON c.credential_id=a.credential_id
         WHERE a.intent_id=? AND a.decision='approved' AND n.used_at IS NOT NULL AND c.revoked_at IS NULL`
        )
        .get(id)
      if (approval?.["bundle_hash"] !== stored.hash)
        return refuse(id, direction, "missing_approval")
    }
    if (direction === "undo") {
      let previous
      try {
        previous = recorded(db, id, "execute")
      } catch {
        return refuse(id, direction, "record_mismatch")
      }
      if (previous?.inverse === null || previous === undefined)
        return refuse(id, direction, "no_inverse")
      const inverse = validateIntent(previous.inverse)
      if (!inverse.ok) return refuse(id, direction, "invalid_inverse")
      if (
        /^(email\.(send|forward|reply|trash)|file\.delete)$/i.test(
          inverse.value.kind
        )
      )
        return refuse(id, direction, "unsafe_inverse")
      if (
        "connector" in intent &&
        (!("connector" in inverse.value) ||
          inverse.value.connector !== intent.connector)
      )
        return refuse(id, direction, "invalid_inverse")
      intent = inverse.value
    }
    if (direction === "execute" && intent.kind === "email.untrash") {
      const source = readIntent(db, intent.args.sourceIntentId)
      let original: Intent | undefined
      let receipt: UpstreamResult | undefined
      try {
        if (source !== undefined)
          original = checkedIntent(parse(source.json), source.hash)
        receipt = executionReceipt(db, intent.args.sourceIntentId)
      } catch {
        return refuse(id, direction, "invalid_restore_source")
      }
      const prior = isRecord(receipt?.result)
        ? receipt.result["priorLabels"]
        : undefined
      const supplied = intent.args.priorLabels
      if (
        source?.kind !== "email.trash" ||
        source.state !== "executed" ||
        original?.kind !== "email.trash" ||
        !("connector" in original) ||
        original.connector !== intent.connector ||
        !isRecord(prior) ||
        !Array.isArray(original.args.messageIds) ||
        original.args.messageIds.length !== supplied.length ||
        intent.args.messageIds.length !== original.args.messageIds.length ||
        !original.args.messageIds.every(
          (messageId, index) => intent.args.messageIds[index] === messageId
        ) ||
        !original.args.messageIds.every((messageId, index) => {
          const row = supplied[index]
          const labels = prior[messageId]
          return (
            row?.messageId === messageId &&
            Array.isArray(labels) &&
            labels.length === row.labels.length &&
            labels.every((label, i) => label === row.labels[i])
          )
        })
      )
        return refuse(id, direction, "invalid_restore_source")
    }
    // Stored pre-binding email intents have no authenticated destination; refuse rather than
    // redirect them after another connector is pinned or the original is disabled.
    if (intent.kind.startsWith("email.") && !("connector" in intent))
      return refuse(id, direction, "connector_unavailable")
    let connector: string
    let operation: string
    try {
      const bindings = intentBindings(db, intent.kind).filter(
        (binding) =>
          !("connector" in intent) || binding.connector === intent.connector
      )
      const binding = bindings.length === 1 ? bindings[0] : undefined
      const pinned =
        binding === undefined
          ? undefined
          : pinnedOperation(db, binding.connector, binding.operation)
      const health =
        binding === undefined
          ? undefined
          : db
              .prepare("SELECT health FROM connectors WHERE name=?")
              .get(binding.connector)?.["health"]
      if (
        binding === undefined ||
        pinned?.effect !== "write" ||
        health === "open"
      )
        return refuse(id, direction, "connector_unavailable")
      connector = binding.connector
      operation = binding.operation
    } catch {
      return refuse(id, direction, "connector_unavailable")
    }
    const writer = registry.get(writerKey(intent.kind, connector))
    if (writer === undefined) return refuse(id, direction, "unknown_writer")
    if (writer.channel === "bridge" && !bridgeConfigured(db, connector))
      return refuse(id, direction, "connector_misconfigured")
    if (writer.channel === "eventkit" && !eventkitConfigured(db, connector))
      return refuse(id, direction, "connector_misconfigured")
    return { intent, writer, stored, connector, operation }
  }

  async function build(
    id: string,
    direction: Direction,
    ready: Ready
  ): Promise<Prepared | ExecutionResult> {
    const { intent, writer, stored, connector, operation } = ready
    let request: WriteRequest
    try {
      const expectedHash =
        direction === "execute" ? stored.hash : payloadHash(intent)
      const built = await writer.buildRequest(intent)
      // Strings and canonical body bytes are copied before the projection or asynchronous call.
      const snapshot = Object.freeze({
        method: built.method,
        url: built.url,
        body: canonicalize(built.body),
      })
      const destination =
        writer.channel === "bridge"
          ? bridgeDestination(intent.kind, snapshot)
          : writer.channel === "eventkit"
            ? eventkitDestination(intent.kind, operation, snapshot)
            : writeDestination(db, connector, operation, snapshot)
      if (destination !== snapshot.url) throw new Error("noncanonical target")
      const decoded = await writer.intentFromRequest(
        Object.freeze({ ...snapshot, body: parse(snapshot.body) }),
        connector
      )
      checkedIntent(decoded, expectedHash)
      request = Object.freeze({
        ...snapshot,
        url: destination,
        connector,
        operation,
        intentKind: intent.kind,
        idempotencyKey: direction === "execute" ? id : `${id}:undo`,
      })
    } catch {
      return atomically(db, () => fail(id, direction, "hash_mismatch"))
    }
    return atomically(db, () => {
      // Authority may change while MIME preparation is awaiting. Validate it again before
      // claiming an attempt or allowing the transport to perform an external write.
      const current = prepare(id, direction)
      if ("ok" in current) return current
      if (
        JSON.stringify(current.stored) !== JSON.stringify(stored) ||
        current.connector !== connector ||
        current.operation !== operation ||
        current.writer !== writer ||
        payloadHash(current.intent) !== payloadHash(intent)
      ) {
        return refuse(id, direction, "invalid_state")
      }
      const claim = db
        .prepare(
          "INSERT OR IGNORE INTO execution_attempts(intent_id,direction,started_at) VALUES (?,?,?)"
        )
        .run(id, direction, new Date().toISOString())
      if (Number(claim.changes) !== 1)
        return refuse(id, direction, "outcome_unresolved")
      auditEvent(db, id, `${direction}.started`, {
        request_hash: payloadHash(request),
      })
      return { intent, writer, request, stored }
    })
  }

  type FileIntent = Extract<
    Intent,
    { kind: "file.create" | "file.rename" | "file.move" | "file.delete" }
  >

  function fileIntent(intent: Intent): intent is FileIntent {
    return (
      intent.kind === "file.create" ||
      intent.kind === "file.rename" ||
      intent.kind === "file.move" ||
      intent.kind === "file.delete"
    )
  }

  function moveDestination(
    intent: Extract<FileIntent, { kind: "file.rename" | "file.move" }>
  ): string {
    if (intent.kind === "file.move") return intent.args.toPath
    // A rename is one component, never a move or a platform-specific path alias.
    if (
      !intent.args.newName ||
      /[\\/:\x00]/.test(intent.args.newName) ||
      [".", ".."].includes(intent.args.newName)
    )
      throw new Error("invalid_path")
    const parent = intent.args.path.slice(
      0,
      Math.max(0, intent.args.path.lastIndexOf("/") + 1)
    )
    return `${parent}${intent.args.newName}`
  }

  /** Files have no HTTP destination: authority is the signed root plus the pinned native helper. */
  async function runFile(
    id: string,
    direction: Direction
  ): Promise<ExecutionResult> {
    const prepared = atomically(db, () => {
      try {
        const existing = recorded(db, id, direction)
        if (existing !== undefined) {
          auditEvent(db, id, `${direction}.replayed`, {
            result_hash: payloadHash(existing.value.result),
          })
          return { ok: true as const, ...existing.value }
        }
      } catch {
        return refuse(id, direction, "record_mismatch")
      }
      const stored = readIntent(db, id)
      if (stored === undefined) return refuse(id, direction, "not_found")
      let intent: Intent
      try {
        intent = checkedIntent(parse(stored.json), stored.hash)
        if (stored.kind !== intent.kind || canonicalize(intent) !== stored.json)
          throw new Error("hash_mismatch")
      } catch {
        return fail(id, direction, "hash_mismatch")
      }
      if (!fileIntent(intent)) return refuse(id, direction, "invalid_state")
      if (
        direction === "execute"
          ? stored.state !== "approved"
          : stored.state !== "executed"
      )
        return refuse(id, direction, "invalid_state")
      if (
        stored.tier === "forbidden" ||
        (intent.kind === "file.delete" && stored.tier !== "approval")
      )
        return refuse(id, direction, "invalid_state")
      if (
        direction === "undo" &&
        stored.tier !== "auto" &&
        intent.kind !== "file.delete"
      )
        return refuse(id, direction, "undo_not_allowed")
      if (stored.tier === "approval") {
        const approval = db
          .prepare(
            `SELECT a.bundle_hash FROM approvals a
          JOIN approval_nonces n ON n.nonce=a.nonce AND n.intent_id=a.intent_id
          JOIN credentials c ON c.credential_id=a.credential_id
          WHERE a.intent_id=? AND a.decision='approved' AND n.used_at IS NOT NULL AND c.revoked_at IS NULL`
          )
          .get(id)
        if (approval?.["bundle_hash"] !== stored.hash)
          return refuse(id, direction, "missing_approval")
      }
      if (files === undefined)
        return refuse(id, direction, "file_helper_unavailable")
      const bindings = intentBindings(db, intent.kind)
      const binding = bindings.length === 1 ? bindings[0] : undefined
      if (
        binding?.connector !== "files" ||
        pinnedOperation(db, binding.connector, binding.operation)?.effect !==
          "write" ||
        db
          .prepare("SELECT health FROM connectors WHERE name=?")
          .get(binding.connector)?.["health"] === "open"
      )
        return refuse(id, direction, "connector_unavailable")
      const root = approvedFileRoot(db, intent.args.root)
      if (root === undefined) return refuse(id, direction, "root_not_allowed")
      let inverse: GateFileHelperRequest | undefined
      if (direction === "undo") {
        let previous
        try {
          previous = recorded(db, id, "execute")
        } catch {
          return refuse(id, direction, "record_mismatch")
        }
        if (previous === undefined || previous.inverse === null)
          return refuse(id, direction, "no_inverse")
        const checked = validateGateFileHelperRequest(previous.inverse)
        if (
          !checked.ok ||
          !("root" in checked.value) ||
          payloadHash(checked.value.root) !== payloadHash(root)
        )
          return refuse(id, direction, "invalid_inverse")
        const candidate = checked.value
        // No caller-selected inverse: bind every field to the original action and authenticated receipt.
        const result = previous.value.result
        const matching =
          intent.kind === "file.create"
            ? candidate.op === "trash" &&
              candidate.path === intent.args.path &&
              /^[0-9a-f-]{36}$/.test(candidate.trashName)
            : intent.kind === "file.delete"
              ? candidate.op === "restore" &&
                candidate.path === intent.args.path &&
                isRecord(result) &&
                candidate.trashName === result["trashName"]
              : candidate.op === "move" &&
                candidate.from === moveDestination(intent) &&
                candidate.to === intent.args.path
        const receiptRoot = isRecord(result)
          ? validateGateFileRoots({
              roots: [{ id: intent.args.root, root: result["root"] }],
            })
          : undefined
        if (
          !matching ||
          !receiptRoot?.ok ||
          payloadHash(receiptRoot.value.roots[0]?.root) !== payloadHash(root)
        )
          return refuse(id, direction, "invalid_inverse")
        inverse = candidate
      }
      const claim = db
        .prepare(
          "INSERT OR IGNORE INTO execution_attempts(intent_id,direction,started_at) VALUES (?,?,?)"
        )
        .run(id, direction, new Date().toISOString())
      if (Number(claim.changes) !== 1)
        return refuse(id, direction, "outcome_unresolved")
      auditEvent(db, id, `${direction}.started`, {
        request_hash: payloadHash({ intent, inverse: inverse ?? null, root }),
      })
      return { stored, intent, root, inverse, helper: files }
    })
    if ("ok" in prepared) return prepared
    let response: UpstreamResult
    let inverse: GateFileHelperRequest | null = null
    try {
      const { intent, root, helper } = prepared
      if (direction === "undo") {
        if (prepared.inverse === undefined)
          return fail(id, direction, "invalid_inverse")
        const reply = await helper(prepared.inverse)
        if (!reply.ok || reply.op !== prepared.inverse.op)
          return fail(
            id,
            direction,
            reply.ok ? "file_helper_failed" : `file_${reply.code}`
          )
        inverse = prepared.inverse
        response = { upstreamRef: null, result: { undone: true } }
      } else {
        const rootId = intent.args.root
        const outcome =
          intent.kind === "file.create"
            ? await createFile(db, helper, {
                rootId,
                path: intent.args.path,
                content: Buffer.from(intent.args.content, "utf8"),
              })
            : intent.kind === "file.delete"
              ? await trashFile(db, helper, { rootId, path: intent.args.path })
              : await moveFile(db, helper, {
                  rootId,
                  from: intent.args.path,
                  to: moveDestination(intent),
                })
        if (!outcome.ok) return fail(id, direction, `file_${outcome.code}`)
        const trashName =
          "trashName" in outcome && typeof outcome.trashName === "string"
            ? outcome.trashName
            : undefined
        inverse =
          intent.kind === "file.create"
            ? {
                op: "trash",
                root,
                path: intent.args.path,
                trashName: randomUUID(),
              }
            : intent.kind === "file.delete"
              ? trashName === undefined
                ? null
                : { op: "restore", root, path: intent.args.path, trashName }
              : {
                  op: "move",
                  root,
                  from: moveDestination(intent),
                  to: intent.args.path,
                }
        if (inverse === null) return fail(id, direction, "file_helper_failed")
        response = {
          upstreamRef: null,
          result: { root, ...(trashName === undefined ? {} : { trashName }) },
        }
      }
    } catch {
      return fail(id, direction, "file_helper_failed")
    }
    return atomically(db, () => {
      const current = readIntent(db, id)
      if (
        current?.hash !== prepared.stored.hash ||
        current.json !== prepared.stored.json ||
        current.state !== prepared.stored.state ||
        current.tier !== prepared.stored.tier
      )
        return fail(id, direction, "changed_during_execution")
      const seq = auditEvent(
        db,
        id,
        direction,
        {
          upstream_ref: response.upstreamRef,
          result: response.result,
          inverse,
        },
        {
          from: current.state,
          to: "executed",
          reason: direction === "undo" ? "undone" : null,
        }
      )
      if (direction === "execute") {
        db.prepare(
          "INSERT INTO executions(intent_id,upstream_ref,result,inverse_op,audit_seq) VALUES (?,?,?,?,?)"
        ).run(
          id,
          response.upstreamRef,
          canonicalize(response.result),
          canonicalize(inverse),
          seq
        )
        db.prepare("UPDATE intents SET state='executed' WHERE id=?").run(id)
      } else
        db.prepare(
          "INSERT INTO execution_undos(intent_id,upstream_ref,result,audit_seq) VALUES (?,?,?,?)"
        ).run(id, response.upstreamRef, canonicalize(response.result), seq)
      return { ok: true, ...response }
    })
  }

  async function run(
    id: string,
    direction: Direction
  ): Promise<ExecutionResult> {
    if (readIntent(db, id)?.kind.startsWith("file."))
      return runFile(id, direction)
    const ready = atomically(db, () => {
      try {
        const existing = recorded(db, id, direction)
        if (existing !== undefined) {
          auditEvent(db, id, `${direction}.replayed`, {
            result_hash: payloadHash(existing.value.result),
          })
          return { ok: true as const, ...existing.value }
        }
      } catch {
        return refuse(id, direction, "record_mismatch")
      }
      return prepare(id, direction)
    })
    if ("ok" in ready) return ready
    const prepared = await build(id, direction, ready)
    if ("ok" in prepared) return prepared
    let response: UpstreamResult
    let inverse: unknown = null
    try {
      const received = await transport(prepared.request)
      // Snapshot adapter results too: later mutations cannot change the audit-bound result.
      response = {
        upstreamRef: received.upstreamRef,
        result: parse(canonicalize(received.result)),
      }
      if (
        response.upstreamRef !== null &&
        typeof response.upstreamRef !== "string"
      )
        throw new Error("bad upstream reference")
      if (direction === "execute" && prepared.stored.tier === "auto") {
        const candidate = prepared.writer.inverse(
          prepared.intent,
          response.result
        )
        if (candidate !== null) {
          const checked = validateIntent(candidate)
          if (!checked.ok) throw new Error("invalid inverse")
          inverse = parse(canonicalize(checked.value))
        }
      } else if (direction === "undo") {
        inverse = prepared.intent
      }
    } catch {
      return fail(id, direction, "upstream_error")
    }
    return atomically(db, () => {
      const current = readIntent(db, id)
      if (
        current?.hash !== prepared.stored.hash ||
        current.json !== prepared.stored.json ||
        current.state !== prepared.stored.state ||
        current.tier !== prepared.stored.tier
      ) {
        return fail(id, direction, "changed_during_execution")
      }
      const seq = auditEvent(
        db,
        id,
        direction,
        {
          upstream_ref: response.upstreamRef,
          result: response.result,
          inverse,
        },
        {
          from: current.state,
          to: "executed",
          reason: direction === "undo" ? "undone" : null,
        }
      )
      if (direction === "execute") {
        db.prepare(
          "INSERT INTO executions(intent_id,upstream_ref,result,inverse_op,audit_seq) VALUES (?,?,?,?,?)"
        ).run(
          id,
          response.upstreamRef,
          canonicalize(response.result),
          inverse === null ? null : canonicalize(inverse),
          seq
        )
        db.prepare("UPDATE intents SET state='executed' WHERE id=?").run(id)
      } else {
        db.prepare(
          "INSERT INTO execution_undos(intent_id,upstream_ref,result,audit_seq) VALUES (?,?,?,?)"
        ).run(id, response.upstreamRef, canonicalize(response.result), seq)
      }
      return { ok: true, ...response }
    })
  }
  return { execute: (id) => run(id, "execute"), undo: (id) => run(id, "undo") }
}
