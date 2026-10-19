import type { DatabaseSync } from "node:sqlite"
import { validateIntent } from "@eido/schemas"
import type { Intent } from "@eido/schemas"
import { append } from "./audit"
import { canonicalize, payloadHash } from "./canonical"
import { intentBindings, pinnedOperation } from "./connectors"
import { atomically } from "./transaction"

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
  buildRequest(this: void, intent: Intent): UpstreamRequest
  /** Reconstruct all intent semantics from the exact method, URL and canonical body. */
  intentFromRequest(this: void, request: Readonly<UpstreamRequest>): unknown
  inverse(this: void, intent: Intent, result: unknown): unknown
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

export function createExecutor(
  db: DatabaseSync,
  writers: readonly UpstreamWriter[],
  transport: WriteTransport
): {
  execute(id: string): Promise<ExecutionResult>
  undo(id: string): Promise<ExecutionResult>
} {
  const registry = new Map<string, UpstreamWriter>()
  for (const writer of writers) {
    if (registry.has(writer.kind)) throw new Error("duplicate writer kind")
    registry.set(writer.kind, writer)
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

  function prepare(
    id: string,
    direction: Direction
  ): Prepared | ExecutionResult {
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
      if (/\.(send|forward|reply|trash|delete)$/i.test(inverse.value.kind))
        return refuse(id, direction, "unsafe_inverse")
      intent = inverse.value
    }
    const writer = registry.get(intent.kind)
    if (writer === undefined) return refuse(id, direction, "unknown_writer")
    let connector: string
    let operation: string
    try {
      const bindings = intentBindings(db, intent.kind)
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
    let request: WriteRequest
    try {
      const expectedHash =
        direction === "execute" ? stored.hash : payloadHash(intent)
      const built = writer.buildRequest(intent)
      // Strings and canonical body bytes are copied before the projection or asynchronous call.
      const snapshot = Object.freeze({
        method: built.method,
        url: built.url,
        body: canonicalize(built.body),
      })
      const url = new URL(snapshot.url)
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !/^(POST|PUT|PATCH|DELETE)$/.test(snapshot.method)
      )
        throw new Error("bad request")
      const decoded = writer.intentFromRequest(
        Object.freeze({ ...snapshot, body: parse(snapshot.body) })
      )
      checkedIntent(decoded, expectedHash)
      request = Object.freeze({
        ...snapshot,
        connector,
        operation,
        intentKind: intent.kind,
        idempotencyKey: direction === "execute" ? id : `${id}:undo`,
      })
    } catch {
      return fail(id, direction, "hash_mismatch")
    }
    // A permanent claim is acquired before any external effect; another process/handle cannot
    // call again, even after a crash that left the upstream outcome unknown.
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
  }

  async function run(
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
      return prepare(id, direction)
    })
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
