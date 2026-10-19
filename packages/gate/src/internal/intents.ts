import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { validateIntent } from "@eido/schemas"
import type { GateIntentStatus, Intent } from "@eido/schemas"
import { append } from "./audit"
import { canonicalize, hashCanonicalString, payloadHash } from "./canonical"
import { issueCurrentNonce } from "./nonces"
import { intentTier } from "./policy"
import type { Policy, Tier, TierDecision } from "./policy"
import { atomically } from "./transaction"

// Intents: the only door through which the data plane can cause an external write. The gate
// validates, canonicalizes, hashes and tiers each proposal itself; nothing here executes, and
// approvals are verified in approvals.ts. Every state change goes through `transition`, which appends its audit
// row in the same transaction. Audit rows and intent_events carry hashes, ids, states and
// reasons, never the payload body.

export type IntentState =
  "proposed" | "pending" | "approved" | "rejected" | "executed" | "failed"
export type IntentOrigin = "reactive" | "proactive" | "task"
export type Actor = "data-plane" | "policy" | "approver" | "executor" | "system"

export type ProposeInput = {
  intent: unknown
  origin: IntentOrigin
  taskId?: string
  contextPackId?: string
  documentIds?: readonly string[]
}

export type ProposeResult =
  | {
      ok: true
      intentId: string
      tier: Tier
      state: IntentState
      payloadHash: string
    }
  | { ok: false; code: "invalid_payload"; errors: string[] }
  | {
      ok: false
      code: "forbidden" | "connector_disabled"
      intentId: string
      errors: string[]
    }

export type EditResult =
  | {
      ok: true
      intentId: string
      tier: Tier
      state: IntentState
      payloadHash: string
    }
  | {
      ok: false
      code:
        | "not_found"
        | "not_pending"
        | "invalid_payload"
        | "kind_changed"
        | "forbidden"
        | "tier_changed"
      errors?: string[]
    }

export type IntentStatus = { state: IntentState; tier: Tier }

export type IntentHistoryEntry = {
  at: string
  from: IntentState | null
  to: IntentState
  actor: Actor
  reason?: string
}

export type PendingIntentSummary = {
  id: string
  kind: string
  tier: "approval"
  state: "pending"
  origin: IntentOrigin
  createdAt: string
  editedFrom?: string
}

// Allowed edges and who may take each. rejected, executed and failed are terminal.
const EDGES: Readonly<
  Record<IntentState, Partial<Record<IntentState, readonly Actor[]>>>
> = {
  proposed: {
    pending: ["policy"],
    approved: ["policy"],
    rejected: ["policy"],
  },
  pending: { approved: ["approver"], rejected: ["approver", "system"] },
  approved: { executed: ["executor"], failed: ["executor"] },
  rejected: {},
  executed: {},
  failed: {},
}

const STATES: readonly IntentState[] = [
  "proposed",
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
]
const TIERS: readonly Tier[] = ["auto", "approval", "forbidden"]
const ORIGINS: readonly IntentOrigin[] = ["reactive", "proactive", "task"]
const ACTORS: readonly Actor[] = [
  "data-plane",
  "policy",
  "approver",
  "executor",
  "system",
]
const PENDING_TIER: readonly "approval"[] = ["approval"]

/** Narrows a stored column to one of `allowed`; anything else means the row was tampered with. */
function member<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string
): T {
  const found = allowed.find((option) => option === value)
  if (found === undefined) {
    throw new Error(`stored ${what} ${String(value)} is unknown`)
  }
  return found
}

const toState = (value: unknown) => member(value, STATES, "intent state")
const toTier = (value: unknown) => member(value, TIERS, "intent tier")
const toOrigin = (value: unknown) => member(value, ORIGINS, "intent origin")

// The tables are STRICT, so a TEXT column holds a string or NULL.
function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

type StoredIntent = {
  id: string
  kind: string
  payloadHash: string
  tier: Tier
  state: IntentState
  origin: IntentOrigin
  taskId: string | null
  contextPackId: string | null
}

function stored(db: DatabaseSync, id: string): StoredIntent | undefined {
  const row = db
    .prepare(
      "SELECT id, kind, payload_hash, tier, state, origin, task_id, context_pack_id FROM intents WHERE id = ?"
    )
    .get(id)
  if (row === undefined) return undefined
  return {
    id: String(row["id"]),
    kind: String(row["kind"]),
    payloadHash: String(row["payload_hash"]),
    tier: toTier(row["tier"]),
    state: toState(row["state"]),
    origin: toOrigin(row["origin"]),
    taskId: optionalText(row["task_id"]),
    contextPackId: optionalText(row["context_pack_id"]),
  }
}

type EventInput = {
  intentId: string
  from: IntentState | null
  to: IntentState
  actor: Actor
  reason: string | null
  action: string
  detailHash: string
}

/** Appends the audit row and the intent_events row that points at it. */
function record(db: DatabaseSync, event: EventInput): void {
  const { seq } = append(db, {
    actor: event.actor,
    action: event.action,
    target: event.intentId,
    detailHash: event.detailHash,
  })
  db.prepare(
    "INSERT INTO intent_events (audit_seq, intent_id, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?)"
  ).run(seq, event.intentId, event.from, event.to, event.reason)
}

function transitionDetail(
  from: IntentState | null,
  to: IntentState,
  reason: string | null,
  hash: string
): string {
  return payloadHash({ from, to, reason, payload_hash: hash })
}

/**
 * Moves an intent along one allowed edge and appends its audit row in the same transaction.
 * Throws for an unknown intent, an edge that does not exist, or an actor that may not take it.
 */
export function transition(
  db: DatabaseSync,
  intentId: string,
  to: IntentState,
  actor: Actor,
  reason?: string
): void {
  atomically(db, () => {
    const intent = stored(db, intentId)
    if (intent === undefined) throw new Error(`unknown intent ${intentId}`)
    const from = intent.state
    const actors = EDGES[from][to]
    if (actors === undefined) {
      throw new Error(`illegal intent transition ${from} -> ${to}`)
    }
    if (!actors.includes(actor)) {
      throw new Error(`${actor} may not move an intent from ${from} to ${to}`)
    }
    db.prepare(
      "UPDATE intents SET state = ?, reason = CASE WHEN ? = 'rejected' THEN ? ELSE reason END WHERE id = ?"
    ).run(to, to, reason ?? null, intentId)
    record(db, {
      intentId,
      from,
      to,
      actor,
      reason: reason ?? null,
      action: "intent.transition",
      detailHash: transitionDetail(
        from,
        to,
        reason ?? null,
        intent.payloadHash
      ),
    })
  })
}

/** Policy's move of an approval-tier intent to pending, with its first single-use nonce. */
export function issuePending(db: DatabaseSync, intentId: string): void {
  atomically(db, () => {
    transition(db, intentId, "pending", "policy")
    issueCurrentNonce(db, intentId)
  })
}

/**
 * Decides a pending intent with a conditional UPDATE, so of two concurrent deciders exactly one
 * changes the row. With `nonce`, the intent must also still hold that nonce as its current one.
 * Returns the intent's payload hash when it decided it, or undefined, having written nothing,
 * when the intent is no longer pending (or the nonce moved).
 */
export function decidePending(
  db: DatabaseSync,
  intentId: string,
  to: "approved" | "rejected",
  actor: Actor,
  options: { reason?: string; nonce?: string } = {}
): string | undefined {
  const actors = EDGES.pending[to] ?? []
  if (!actors.includes(actor)) {
    throw new Error(`${actor} may not move an intent from pending to ${to}`)
  }
  const reason = options.reason ?? null
  const nonce = options.nonce ?? null
  return atomically(db, () => {
    const changed = db
      .prepare(
        `UPDATE intents SET state = ?, current_nonce = NULL, reason = CASE WHEN ? = 'rejected' THEN ? ELSE reason END
         WHERE id = ? AND state = 'pending' AND (? IS NULL OR current_nonce = ?)
         RETURNING payload_hash`
      )
      .get(to, to, reason, intentId, nonce, nonce)
    if (changed === undefined) return undefined
    const hash = String(changed["payload_hash"])
    record(db, {
      intentId,
      from: "pending",
      to,
      actor,
      reason,
      action: "intent.transition",
      detailHash: transitionDetail("pending", to, reason, hash),
    })
    return hash
  })
}

type Checked =
  | { ok: true; intent: Intent; canonical: string; hash: string }
  | { ok: false; errors: string[] }

/** Schema-validates an intent and computes its canonical form and hash. */
function check(value: unknown): Checked {
  const result = validateIntent(value)
  if (!result.ok) return result
  let canonical: string
  try {
    canonical = canonicalize(result.value)
  } catch {
    return { ok: false, errors: ["$: not representable as canonical JSON"] }
  }
  return {
    ok: true,
    intent: result.value,
    canonical,
    hash: hashCanonicalString(canonical),
  }
}

type NewIntent = {
  checked: Extract<Checked, { ok: true }>
  tier: Tier
  origin: IntentOrigin
  taskId: string | null
  contextPackId: string | null
  editedFrom: string | null
}

function insert(db: DatabaseSync, intent: NewIntent): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO intents (id, kind, payload_json, payload_hash, tier, state, origin, edited_from, task_id, context_pack_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, NULL, ?)`
  ).run(
    id,
    intent.checked.intent.kind,
    intent.checked.canonical,
    intent.checked.hash,
    intent.tier,
    intent.origin,
    intent.editedFrom,
    intent.taskId,
    intent.contextPackId,
    new Date().toISOString()
  )
  return id
}

/** The first transition, taken by policy: auto to approved, approval to pending, else rejected. */
function applyTier(db: DatabaseSync, id: string, decision: TierDecision): void {
  switch (decision.tier) {
    case "auto":
      transition(db, id, "approved", "policy")
      return
    case "approval":
      issuePending(db, id)
      return
    case "forbidden":
      transition(db, id, "rejected", "policy", decision.reason)
  }
}

/** Validates, hashes and tiers a proposal, stores it and applies the first transition. */
export function propose(
  db: DatabaseSync,
  policy: Policy,
  input: ProposeInput
): ProposeResult {
  const contextPackId = input.contextPackId ?? null
  const documentIds = input.documentIds ?? []
  const checked = check(input.intent)
  if (!checked.ok) {
    append(db, {
      actor: "data-plane",
      action: "intent.invalid",
      target: "intent",
      detailHash: payloadHash({
        errors: checked.errors,
        origin: input.origin,
        context_pack_id: contextPackId,
        document_ids: documentIds,
      }),
    })
    return { ok: false, code: "invalid_payload", errors: checked.errors }
  }
  const { id, decision } = atomically(db, () => {
    const decision = intentTier(db, policy, checked.intent)
    const id = insert(db, {
      checked,
      tier: decision.tier,
      origin: input.origin,
      taskId: input.taskId ?? null,
      contextPackId,
      editedFrom: null,
    })
    record(db, {
      intentId: id,
      from: null,
      to: "proposed",
      actor: "data-plane",
      reason: null,
      action: "intent.proposed",
      detailHash: payloadHash({
        from: null,
        to: "proposed",
        reason: null,
        payload_hash: checked.hash,
        origin: input.origin,
        context_pack_id: contextPackId,
        document_ids: documentIds,
      }),
    })
    applyTier(db, id, decision)
    return { id, decision }
  })
  if (decision.tier === "forbidden") {
    return {
      ok: false,
      code:
        decision.reason === "connector_disabled"
          ? "connector_disabled"
          : "forbidden",
      intentId: id,
      errors: [decision.reason],
    }
  }
  return {
    ok: true,
    intentId: id,
    tier: decision.tier,
    state: decision.tier === "auto" ? "approved" : "pending",
    payloadHash: checked.hash,
  }
}

/**
 * Replaces a pending intent with an edited one. Policy re-runs on the new payload; an edit that
 * would be forbidden or would change the tier is refused and the original stays pending.
 * Otherwise, in one transaction, the original is rejected with reason `edited` and the new
 * intent lands in pending with `edited_from` set. Every refusal is audited.
 */
export function editIntent(
  db: DatabaseSync,
  policy: Policy,
  originalId: string,
  newIntent: unknown,
  actor: Actor
): EditResult {
  const original = stored(db, originalId)
  const checked = check(newIntent)
  const newHash = checked.ok ? checked.hash : null
  const refuse = (
    code: Extract<EditResult, { ok: false }>["code"],
    errors?: string[]
  ): EditResult => {
    const state = original?.state ?? null
    append(db, {
      actor,
      action: "intent.edit_refused",
      target: originalId,
      detailHash: payloadHash({
        from: state,
        to: state,
        reason: code,
        payload_hash: newHash,
      }),
    })
    return errors === undefined
      ? { ok: false, code }
      : { ok: false, code, errors }
  }
  if (original === undefined) return refuse("not_found")
  if (original.state !== "pending") return refuse("not_pending")
  if (!checked.ok) return refuse("invalid_payload", checked.errors)
  if (checked.intent.kind !== original.kind) return refuse("kind_changed")
  const decision = intentTier(db, policy, checked.intent)
  if (decision.tier === "forbidden") {
    return refuse("forbidden", [decision.reason])
  }
  if (decision.tier !== original.tier) return refuse("tier_changed")
  const id = atomically(db, () => {
    transition(db, originalId, "rejected", actor, "edited")
    const id = insert(db, {
      checked,
      tier: decision.tier,
      origin: original.origin,
      taskId: original.taskId,
      contextPackId: original.contextPackId,
      editedFrom: originalId,
    })
    record(db, {
      intentId: id,
      from: null,
      to: "proposed",
      actor,
      reason: "edited",
      action: "intent.proposed",
      detailHash: payloadHash({
        from: null,
        to: "proposed",
        reason: "edited",
        payload_hash: checked.hash,
        edited_from: originalId,
      }),
    })
    applyTier(db, id, decision)
    return id
  })
  return {
    ok: true,
    intentId: id,
    tier: decision.tier,
    state: "pending",
    payloadHash: checked.hash,
  }
}

/**
 * Records an undo by the executor (#12): an audit row and a history entry from executed to
 * executed with reason `undone`. The intent's state does not change. `detailHash` is the
 * executor's hash over the inverse operation and its result.
 */
export function recordUndo(
  db: DatabaseSync,
  intentId: string,
  detailHash: string
): void {
  atomically(db, () => {
    const intent = stored(db, intentId)
    if (intent === undefined) throw new Error(`unknown intent ${intentId}`)
    if (intent.state !== "executed") {
      throw new Error(
        `only an executed intent can be undone, not ${intent.state}`
      )
    }
    record(db, {
      intentId,
      from: "executed",
      to: "executed",
      actor: "executor",
      reason: "undone",
      action: "intent.undo",
      detailHash,
    })
  })
}

/** State and tier of one intent; no payload. */
export function intentStatus(
  db: DatabaseSync,
  intentId: string
): IntentStatus | undefined {
  const intent = stored(db, intentId)
  return intent === undefined
    ? undefined
    : { state: intent.state, tier: intent.tier }
}

/** One intent as the intent API shows it: kind, tier, state and edited_from; no payload. */
export function intentSummary(
  db: DatabaseSync,
  intentId: string
): GateIntentStatus | undefined {
  const row = db
    .prepare(
      "SELECT id, kind, tier, state, edited_from FROM intents WHERE id = ?"
    )
    .get(intentId)
  if (row === undefined) return undefined
  return {
    id: String(row["id"]),
    kind: String(row["kind"]),
    tier: toTier(row["tier"]),
    state: toState(row["state"]),
    edited_from: optionalText(row["edited_from"]),
  }
}

/** The intent's transitions, oldest first, read from its audit_log rows. */
export function intentHistory(
  db: DatabaseSync,
  intentId: string
): IntentHistoryEntry[] {
  return db
    .prepare(
      `SELECT a.ts, a.actor, e.from_state, e.to_state, e.reason
       FROM intent_events e JOIN audit_log a ON a.seq = e.audit_seq
       WHERE e.intent_id = ? ORDER BY e.audit_seq ASC`
    )
    .all(intentId)
    .map((row) => {
      const from = row["from_state"]
      const reason = optionalText(row["reason"])
      const entry: IntentHistoryEntry = {
        at: String(row["ts"]),
        from: from === null ? null : toState(from),
        to: toState(row["to_state"]),
        actor: member(row["actor"], ACTORS, "audit actor"),
      }
      return reason === null ? entry : { ...entry, reason }
    })
}

/** Intents waiting for an approval, oldest first; no payload. */
export function pendingIntents(db: DatabaseSync): PendingIntentSummary[] {
  return db
    .prepare(
      "SELECT id, kind, tier, origin, created_at, edited_from FROM intents WHERE state = 'pending' ORDER BY created_at ASC, rowid ASC"
    )
    .all()
    .map((row) => {
      const editedFrom = optionalText(row["edited_from"])
      const summary: PendingIntentSummary = {
        id: String(row["id"]),
        kind: String(row["kind"]),
        tier: member(row["tier"], PENDING_TIER, "pending tier"),
        state: "pending",
        origin: toOrigin(row["origin"]),
        createdAt: String(row["created_at"]),
      }
      return editedFrom === null ? summary : { ...summary, editedFrom }
    })
}
