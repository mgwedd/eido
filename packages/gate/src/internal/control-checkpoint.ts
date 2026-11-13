import { randomUUID } from "node:crypto"
import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import { append, auditRowHash } from "./audit"
import { payloadHash } from "./canonical"
import { approvalRefHash, controlChallenge, hexDigest } from "./control-ceremony"
import { atomically } from "./transaction"
import {
  fromBase64url,
  parseAuthenticatorData,
  parseClientData,
  verifyAssertionSignature,
} from "./webauthn"

// The protected control-state checkpoint (ADR 0005, #200).
//
// `eido-control.db` holds the connector pins, the approved policy and the credential roster, and
// a process that can write the file and its WAL can rewrite all of them together with a matching
// audit row. The gate therefore keeps one record outside the database, in a store only the gate
// can reach (the macOS Keychain on the Mac): a generation, the SHA-256 of a canonical snapshot of
// that control state, the credential roster, and the complete WebAuthn assertion of every active
// signed change. Before any read that can use connector or policy authority, the gate recomputes
// the snapshot from the database and compares it with the record; a difference denies the read.
//
// The record is loaded from the store at startup and before every control mutation, and the gate
// compares each read against its in-process copy of it, which only a successful publish changes.
// A mutation holds the write lock, checks the current state, makes the change, freezes the new
// snapshot, commits, and then publishes exactly that snapshot. A crash or a failed publish in
// between leaves the database ahead of the record, which denies authority until supervised
// recovery (`establishControlEpoch`). The gate never derives a record from the database on its
// own, except for a store that has never been initialised against a database with no control
// state at all.

export type ControlStore = {
  /** The stored record, or undefined when the store was never initialised. Throws when unreadable. */
  load: () => string | undefined
  /** Replaces the stored record. Throws when the write cannot be confirmed. */
  save: (value: string) => void
}

/** In-memory store for tests and for tools that provide their own protection. */
export class MemoryControlStore implements ControlStore {
  value: string | undefined
  failSaves = false
  failLoads = false

  load(): string | undefined {
    if (this.failLoads) throw new Error("store unreadable")
    return this.value
  }

  save(value: string): void {
    if (this.failSaves) throw new Error("store write failed")
    this.value = value
  }
}

export type DenyReason =
  | "uninitialized"
  | "store_unreadable"
  | "store_malformed"
  | "reverify_failed"
  | "control_state_mismatch"
  | "stale_generation"
  | "checkpoint_write_failed"
  | "second_instance"
  | "unsupported_transaction"
  | "unsigned_control_change"

/** Authority-bearing reads and control changes throw this while the control state is unverified. */
export class ControlStateError extends Error {
  readonly reason: DenyReason
  constructor(reason: DenyReason) {
    super(`control state not verified: ${reason}`)
    this.name = "ControlStateError"
    this.reason = reason
  }
}

export type Assertion = {
  authenticatorData: string
  clientDataJSON: string
  signature: string
}

/** One signed control change with everything needed to verify its signature again after a restart. */
export type Provenance = {
  approvalId: string
  purpose: string
  target: string
  payloadHash: string
  nonce: string
  approvalRefHash: string
  credentialId: string
  signCount: number
  auditSeq: number
  auditRowHash: string
  assertion: Assertion
}

export type RosterEntry = {
  credentialId: string
  publicKey: string
  revoked: boolean
}

type ValueKind = "policy" | "sensitivity" | "file-roots"
const VALUE_TABLES: readonly (readonly [ValueKind, string])[] = [
  ["policy", "approved_policy"],
  ["sensitivity", "approved_sensitivity"],
  ["file-roots", "approved_file_roots"],
]

// Audit actions that move control state. The newest one's sequence and row hash are bound into
// the snapshot, so rolling the database back across any of them changes it.
const CONTROL_ACTIONS = [
  "connector.pinned",
  "policy.changed",
  "policy.sensitivity.changed",
  "files.roots.changed",
  "credential.registered",
  "credential.revoked",
  "connector.disabled_unanchored",
  "control.epoch_established",
] as const

type ApprovalBinding = {
  id: string
  purpose: string
  target: string
  payloadHash: string
  approvalRefHash: string | null
  auditSeq: number | null
  auditRowHash: string | null
}

/** The canonical control state. Health counters, sign counters and timestamps are excluded. */
export type Snapshot = {
  connectors: {
    name: string
    manifestHash: string
    pinApprovalRefHash: string | null
    pinApprovalId: string | null
  }[]
  values: { kind: ValueKind; payloadHash: string; approvalId: string }[]
  roster: RosterEntry[]
  approvals: ApprovalBinding[]
  head: { seq: number; rowHash: string } | null
}

export type ControlRecord = {
  version: 1
  installationId: string
  epoch: string
  generation: number
  snapshotHash: string
  roster: RosterEntry[]
  provenance: Provenance[]
}

const MAX_RECORD_BYTES = 256 * 1024

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function bindingFor(db: DatabaseSync, id: string): ApprovalBinding | undefined {
  const row = db
    .prepare(
      "SELECT id, purpose, target, payload_hash, approval_ref_hash, audit_seq FROM control_approvals WHERE id = ?"
    )
    .get(id)
  if (row === undefined) return undefined
  const seq = typeof row["audit_seq"] === "number" ? row["audit_seq"] : null
  return {
    id: String(row["id"]),
    purpose: String(row["purpose"]),
    target: String(row["target"]),
    payloadHash: String(row["payload_hash"]),
    approvalRefHash: nullableString(row["approval_ref_hash"]),
    auditSeq: seq,
    auditRowHash: seq === null ? null : (auditRowHash(db, seq) ?? null),
  }
}

/** Recomputes the canonical control snapshot from the database. */
export function computeSnapshot(db: DatabaseSync): Snapshot {
  const approvalIds = new Set<string>()
  const connectors = db
    .prepare(
      "SELECT name, manifest_hash, pin_approval_ref_hash FROM connectors ORDER BY name"
    )
    .all()
    .map((row) => {
      const ref = nullableString(row["pin_approval_ref_hash"])
      const approval =
        ref === null
          ? undefined
          : db
              .prepare(
                "SELECT id FROM control_approvals WHERE approval_ref_hash = ?"
              )
              .get(ref)
      const id = nullableString(approval?.["id"])
      if (id !== null) approvalIds.add(id)
      return {
        name: String(row["name"]),
        manifestHash: String(row["manifest_hash"]),
        pinApprovalRefHash: ref,
        pinApprovalId: id,
      }
    })
  const values: Snapshot["values"] = []
  for (const [kind, table] of VALUE_TABLES) {
    const row = db
      .prepare(
        `SELECT payload_hash, approval_id FROM ${table} WHERE singleton = 1`
      )
      .get()
    if (row === undefined) continue
    const approvalId = String(row["approval_id"])
    approvalIds.add(approvalId)
    values.push({ kind, payloadHash: String(row["payload_hash"]), approvalId })
  }
  const roster = db
    .prepare(
      "SELECT credential_id, public_key, revoked_at FROM credentials ORDER BY credential_id"
    )
    .all()
    .map((row) => ({
      credentialId: String(row["credential_id"]),
      publicKey: String(row["public_key"]),
      revoked: row["revoked_at"] !== null,
    }))
  const approvals = [...approvalIds]
    .sort()
    .flatMap((id) => bindingFor(db, id) ?? [])
  const placeholders = CONTROL_ACTIONS.map(() => "?").join(", ")
  const last = db
    .prepare(
      `SELECT seq FROM audit_log WHERE action IN (${placeholders}) ORDER BY seq DESC LIMIT 1`
    )
    .get(...CONTROL_ACTIONS)
  const headSeq = typeof last?.["seq"] === "number" ? last["seq"] : undefined
  const headHash =
    headSeq === undefined ? undefined : auditRowHash(db, headSeq)
  return {
    connectors,
    values,
    roster,
    approvals,
    head:
      headSeq === undefined || headHash === undefined
        ? null
        : { seq: headSeq, rowHash: headHash },
  }
}

function snapshotHash(snapshot: Snapshot): string {
  return payloadHash(snapshot)
}

function hasControlState(snapshot: Snapshot): boolean {
  return (
    snapshot.connectors.length > 0 ||
    snapshot.values.length > 0 ||
    snapshot.roster.length > 0 ||
    snapshot.head !== null
  )
}

// ---- Record encoding. Input from the store is parsed, never cast.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRoster(value: unknown): RosterEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: RosterEntry[] = []
  for (const entry of value as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry["credentialId"] !== "string" ||
      typeof entry["publicKey"] !== "string" ||
      typeof entry["revoked"] !== "boolean"
    )
      return undefined
    out.push({
      credentialId: entry["credentialId"],
      publicKey: entry["publicKey"],
      revoked: entry["revoked"],
    })
  }
  return out
}

function parseProvenance(value: unknown): Provenance[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Provenance[] = []
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return undefined
    const assertion = entry["assertion"]
    if (
      typeof entry["approvalId"] !== "string" ||
      typeof entry["purpose"] !== "string" ||
      typeof entry["target"] !== "string" ||
      typeof entry["payloadHash"] !== "string" ||
      typeof entry["nonce"] !== "string" ||
      typeof entry["approvalRefHash"] !== "string" ||
      typeof entry["credentialId"] !== "string" ||
      typeof entry["signCount"] !== "number" ||
      typeof entry["auditSeq"] !== "number" ||
      typeof entry["auditRowHash"] !== "string" ||
      !isRecord(assertion) ||
      typeof assertion["authenticatorData"] !== "string" ||
      typeof assertion["clientDataJSON"] !== "string" ||
      typeof assertion["signature"] !== "string"
    )
      return undefined
    out.push({
      approvalId: entry["approvalId"],
      purpose: entry["purpose"],
      target: entry["target"],
      payloadHash: entry["payloadHash"],
      nonce: entry["nonce"],
      approvalRefHash: entry["approvalRefHash"],
      credentialId: entry["credentialId"],
      signCount: entry["signCount"],
      auditSeq: entry["auditSeq"],
      auditRowHash: entry["auditRowHash"],
      assertion: {
        authenticatorData: assertion["authenticatorData"],
        clientDataJSON: assertion["clientDataJSON"],
        signature: assertion["signature"],
      },
    })
  }
  return out
}

/** The record in `raw`, or undefined when it is not a well-formed version 1 record. */
export function parseControlRecord(raw: string): ControlRecord | undefined {
  if (raw.length > MAX_RECORD_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value["version"] !== 1) return undefined
  const roster = parseRoster(value["roster"])
  const provenance = parseProvenance(value["provenance"])
  const generation = value["generation"]
  if (
    roster === undefined ||
    provenance === undefined ||
    typeof value["installationId"] !== "string" ||
    typeof value["epoch"] !== "string" ||
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    typeof value["snapshotHash"] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value["snapshotHash"])
  )
    return undefined
  return {
    version: 1,
    installationId: value["installationId"],
    epoch: value["epoch"],
    generation,
    snapshotHash: value["snapshotHash"],
    roster,
    provenance,
  }
}

function encode(record: ControlRecord): string {
  const raw = JSON.stringify(record)
  if (raw.length > MAX_RECORD_BYTES)
    throw new Error("control checkpoint record is too large")
  return raw
}

// ---- Provenance reverification: the stored assertion bytes prove the owner signed the change.

function reverify(record: ControlRecord): boolean {
  for (const p of record.provenance) {
    const key = record.roster.find((r) => r.credentialId === p.credentialId)
    const auth = fromBase64url(p.assertion.authenticatorData)
    const client = fromBase64url(p.assertion.clientDataJSON)
    const signature = fromBase64url(p.assertion.signature)
    if (
      key === undefined ||
      auth === undefined ||
      client === undefined ||
      signature === undefined
    )
      return false
    const parsedAuth = parseAuthenticatorData(auth)
    const parsedClient = parseClientData(client)
    if (
      parsedAuth === undefined ||
      parsedClient === undefined ||
      parsedAuth.signCount !== p.signCount ||
      parsedClient.challenge !==
        controlChallenge(
          p.purpose,
          p.target,
          p.approvalId,
          p.payloadHash,
          p.nonce
        ) ||
      !verifyAssertionSignature(
        Buffer.from(key.publicKey, "base64url"),
        auth,
        client,
        signature
      ) ||
      approvalRefHash({
        id: p.approvalId,
        purpose: p.purpose,
        target: p.target,
        payloadHash: p.payloadHash,
        credentialHash: hexDigest(p.credentialId),
        signatureHash: hexDigest(p.assertion.signature),
        signCount: p.signCount,
        nonce: p.nonce,
      }) !== p.approvalRefHash
    )
      return false
  }
  return true
}

// ---- One gate process per control store.

type Lock = { release: () => void }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

function acquireLock(path: string): Lock | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return {
        release: () => {
          try {
            if (readFileSync(path, "utf8") === String(process.pid))
              unlinkSync(path)
          } catch {
            // already gone
          }
        },
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
        throw error
      let pid = Number.NaN
      try {
        pid = Number(readFileSync(path, "utf8"))
      } catch {
        // vanished between the two calls: try again
        continue
      }
      if (Number.isInteger(pid) && alive(pid)) return undefined
      try {
        unlinkSync(path)
      } catch {
        // someone else removed it
      }
    }
  }
  return undefined
}

// ---- Guard state, one per database.

type State = {
  store: ControlStore
  lock: Lock | undefined
  denied: DenyReason | undefined
  record: ControlRecord | undefined
  raw: string | undefined
  depth: number
  pending: Provenance[]
}

const guards = new WeakMap<DatabaseSync, State>()

export type ControlCheckpoint = {
  /** Undefined while authority reads are allowed, else why they are denied. */
  denied: () => DenyReason | undefined
  /** The protected generation, for status output. */
  generation: () => number | undefined
  /** Releases the instance lock and detaches the guard. */
  close: () => void
}

export type AttachOptions = {
  store: ControlStore
  /** The single-instance lock file; a second live gate on the same store is denied. */
  lockPath?: string
}

function deny(state: State, reason: DenyReason): void {
  state.denied = reason
  state.record = undefined
  state.raw = undefined
}

function initialRecord(snapshot: Snapshot): ControlRecord {
  return {
    version: 1,
    installationId: randomUUID(),
    epoch: randomUUID(),
    generation: 1,
    snapshotHash: snapshotHash(snapshot),
    roster: [],
    provenance: [],
  }
}

/**
 * Attaches the checkpoint to this database. Startup fails closed: a missing, unreadable,
 * malformed, unverifiable or mismatched record denies every authority read until supervised
 * recovery. A store that was never initialised is initialised only when the database holds no
 * control state at all; otherwise it stays denied until `establishControlEpoch` runs.
 */
export function attachControlCheckpoint(
  db: DatabaseSync,
  options: AttachOptions
): ControlCheckpoint {
  const state: State = {
    store: options.store,
    lock: undefined,
    denied: undefined,
    record: undefined,
    raw: undefined,
    depth: 0,
    pending: [],
  }
  guards.set(db, state)
  if (options.lockPath !== undefined) {
    state.lock = acquireLock(options.lockPath)
    if (state.lock === undefined) {
      state.denied = "second_instance"
      return handle(db, state)
    }
  }
  let raw: string | undefined
  try {
    raw = options.store.load()
  } catch {
    deny(state, "store_unreadable")
    return handle(db, state)
  }
  const snapshot = computeSnapshot(db)
  if (raw === undefined) {
    if (hasControlState(snapshot)) {
      deny(state, "uninitialized")
      return handle(db, state)
    }
    const record = initialRecord(snapshot)
    try {
      raw = encode(record)
      options.store.save(raw)
    } catch {
      deny(state, "checkpoint_write_failed")
      return handle(db, state)
    }
    state.record = record
    state.raw = raw
    return handle(db, state)
  }
  const record = parseControlRecord(raw)
  if (record === undefined) {
    deny(state, "store_malformed")
  } else if (!reverify(record)) {
    deny(state, "reverify_failed")
  } else if (snapshotHash(snapshot) !== record.snapshotHash) {
    deny(state, "control_state_mismatch")
  } else {
    state.record = record
    state.raw = raw
  }
  return handle(db, state)
}

function handle(db: DatabaseSync, state: State): ControlCheckpoint {
  return {
    denied: () => state.denied,
    generation: () => state.record?.generation,
    close: () => {
      state.lock?.release()
      if (guards.get(db) === state) guards.delete(db)
    },
  }
}

/** What an authority read may rely on: which stored values carry an anchored owner signature. */
export type ControlView = {
  /** True when this connector's current pin was signed and its assertion is retained. */
  pinAnchored: (name: string, pinApprovalRefHash: string | null) => boolean
  /** True when this approved value's signed approval is retained. */
  approvalAnchored: (approvalId: string) => boolean
}

function verify(state: State, db: DatabaseSync): ControlRecord {
  if (state.denied !== undefined) throw new ControlStateError(state.denied)
  const record = state.record
  if (record === undefined) throw new ControlStateError("store_unreadable")
  if (snapshotHash(computeSnapshot(db)) !== record.snapshotHash)
    throw new ControlStateError("control_state_mismatch")
  return record
}

function viewOf(record: ControlRecord): ControlView {
  return {
    pinAnchored: (name, ref) =>
      ref !== null &&
      record.provenance.some(
        (p) =>
          p.purpose === "manifest.pin" &&
          p.target === name &&
          p.approvalRefHash === ref
      ),
    approvalAnchored: (id) => record.provenance.some((p) => p.approvalId === id),
  }
}

/**
 * Runs `read` against the verified control state, in one read transaction so the rows it reads
 * are the rows that were verified. Throws `ControlStateError` when the state does not match the
 * protected record. With no checkpoint attached (tests, unprotected development) the view is
 * undefined and nothing is anchored or enforced.
 */
export function withControlView<T>(
  db: DatabaseSync,
  read: (view: ControlView | undefined) => T
): T {
  const state = guards.get(db)
  if (state === undefined) return read(undefined)
  const own = !db.isTransaction
  if (own) db.exec("BEGIN")
  try {
    return read(viewOf(verify(state, db)))
  } finally {
    if (own) db.exec("COMMIT")
  }
}

/** Throws `ControlStateError` unless the control state matches the protected record. */
export function requireControlState(db: DatabaseSync): void {
  withControlView(db, () => undefined)
}

/** Non-throwing status for administrative reads, which may report a mismatch but never serve it. */
export function controlStatus(
  db: DatabaseSync
): { enforced: false } | { enforced: true; denied: DenyReason | undefined } {
  const state = guards.get(db)
  if (state === undefined) return { enforced: false }
  try {
    verify(state, db)
    return { enforced: true, denied: undefined }
  } catch (error) {
    return {
      enforced: true,
      denied: error instanceof ControlStateError ? error.reason : "store_unreadable",
    }
  }
}

export type CapturedAssertion = {
  approvalId: string
  purpose: string
  target: string
  payloadHash: string
  nonce: string
  approvalRefHash: string
  credentialId: string
  signCount: number
  auditSeq: number
  assertion: Assertion
}

/** Records the verified assertion of a control change made in this transaction. */
export function captureControlAssertion(
  db: DatabaseSync,
  captured: CapturedAssertion
): void {
  const state = guards.get(db)
  if (state === undefined || state.depth === 0) return
  const rowHash = auditRowHash(db, captured.auditSeq)
  if (rowHash === undefined) throw new ControlStateError("unsigned_control_change")
  state.pending.push({ ...captured, auditRowHash: rowHash })
}

export type ControlChangeKind =
  /** A change the owner signed: its assertion must be captured in the same transaction. */
  | "signed"
  /** The credential roster changed through the gate's own authenticated enrolment or revocation. */
  | "roster"

function sameJson(a: unknown, b: unknown): boolean {
  return payloadHash(a) === payloadHash(b)
}

function nextRecord(
  state: State,
  previous: ControlRecord,
  kind: ControlChangeKind,
  before: Snapshot,
  after: Snapshot
): ControlRecord {
  const referenced = new Set(after.approvals.map((a) => a.id))
  const kept = previous.provenance.filter((p) => referenced.has(p.approvalId))
  const added = state.pending.filter((p) => referenced.has(p.approvalId))
  // A newer signed change to the same value supersedes the older assertion.
  const provenance = [
    ...kept.filter(
      (p) =>
        !added.some((a) => a.purpose === p.purpose && a.target === p.target)
    ),
    ...added,
  ]
  const stateChanged =
    !sameJson(before.connectors, after.connectors) ||
    !sameJson(before.values, after.values) ||
    !sameJson(before.approvals, after.approvals)
  if (kind === "signed") {
    // Nothing about the roster moves through a signed change, and a change to a pin or a policy
    // value must arrive with its assertion.
    if (!sameJson(before.roster, after.roster))
      throw new ControlStateError("unsigned_control_change")
    if (stateChanged && added.length === 0)
      throw new ControlStateError("unsigned_control_change")
  } else if (stateChanged || added.length > 0) {
    throw new ControlStateError("unsigned_control_change")
  }
  return {
    ...previous,
    generation: previous.generation + 1,
    snapshotHash: snapshotHash(after),
    roster: after.roster,
    provenance,
  }
}

/**
 * Runs a control change as one transaction under the checkpoint protocol: take the write lock,
 * check the stored record is still the one this gate holds and that the database matches it, make
 * the change, freeze the new snapshot, commit, publish exactly that snapshot, and check the
 * committed database against it. With no checkpoint attached it is a plain transaction.
 */
export function controlTransaction<T>(
  db: DatabaseSync,
  kind: ControlChangeKind,
  work: () => T
): T {
  const state = guards.get(db)
  if (state === undefined) return atomically(db, work)
  if (state.depth > 0) return atomically(db, work)
  if (db.isTransaction) throw new ControlStateError("unsupported_transaction")
  let next: ControlRecord | undefined
  let nextRaw = ""
  state.depth = 1
  state.pending = []
  try {
    const result = atomically(db, () => {
      if (state.denied !== undefined) throw new ControlStateError(state.denied)
      let stored: string | undefined
      try {
        stored = state.store.load()
      } catch {
        deny(state, "store_unreadable")
        throw new ControlStateError("store_unreadable")
      }
      // Another gate instance moved the protected record on: stop, never overwrite it.
      if (stored !== state.raw) throw new ControlStateError("stale_generation")
      const previous = verify(state, db)
      const before = computeSnapshot(db)
      const out = work()
      const after = computeSnapshot(db)
      next = nextRecord(state, previous, kind, before, after)
      nextRaw = encode(next)
      return out
    })
    if (next === undefined) throw new ControlStateError("unsigned_control_change")
    if (next.snapshotHash === state.record?.snapshotHash) return result
    try {
      state.store.save(nextRaw)
    } catch {
      // The database is ahead of the protected record: deny until supervised recovery.
      deny(state, "checkpoint_write_failed")
      throw new ControlStateError("checkpoint_write_failed")
    }
    state.record = next
    state.raw = nextRaw
    if (snapshotHash(computeSnapshot(db)) !== next.snapshotHash) {
      deny(state, "control_state_mismatch")
      throw new ControlStateError("control_state_mismatch")
    }
    return result
  } finally {
    state.depth = 0
    state.pending = []
  }
}

// ---- Supervised recovery and migration, run by a local administrator with the gate stopped.

export type EpochResult = {
  installationId: string
  epoch: string
  generation: number
  revokedCredentials: number
  disabledConnectors: number
}

/**
 * Establishes a new installation epoch from the database as it is, for an installation that has
 * no usable checkpoint: an upgrade from before the anchor, a lost or damaged record, or a database
 * ahead of the record after a crash. It never trusts the old signed state: every enrolled passkey
 * is revoked, every connector is disabled, and no old pin or policy value counts as signed, so the
 * owner must enrol a passkey on the Mac again (`enrol-code`) and sign each pin and policy change
 * afresh. Old rows stay for review. Refused while a gate runs against the same store.
 */
export function establishControlEpoch(
  db: DatabaseSync,
  options: AttachOptions
): EpochResult {
  const lock =
    options.lockPath === undefined ? undefined : acquireLock(options.lockPath)
  if (options.lockPath !== undefined && lock === undefined)
    throw new Error("a gate is running against this control store")
  try {
    guards.delete(db)
    let previous: ControlRecord | undefined
    try {
      const raw = options.store.load()
      previous = raw === undefined ? undefined : parseControlRecord(raw)
    } catch {
      previous = undefined
    }
    const installationId = previous?.installationId ?? randomUUID()
    const epoch = randomUUID()
    const generation = (previous?.generation ?? 0) + 1
    let revoked = 0
    let disabled = 0
    const snapshot = atomically(db, () => {
      const now = new Date().toISOString()
      for (const row of db
        .prepare("SELECT name, manifest_hash FROM connectors WHERE enabled = 1")
        .all()) {
        append(db, {
          actor: "system",
          action: "connector.disabled_unanchored",
          target: String(row["name"]),
          detailHash: payloadHash({ manifestHash: String(row["manifest_hash"]) }),
        })
        disabled++
      }
      db.exec("UPDATE connectors SET enabled = 0 WHERE enabled = 1")
      revoked = Number(
        db
          .prepare(
            "UPDATE credentials SET revoked_at = ? WHERE revoked_at IS NULL"
          )
          .run(now).changes
      )
      db.prepare(
        "UPDATE control_approvals SET superseded_at = ? WHERE used_at IS NULL AND superseded_at IS NULL"
      ).run(now)
      append(db, {
        actor: "system",
        action: "control.epoch_established",
        target: "control",
        detailHash: payloadHash({ installationId, epoch, generation }),
      })
      return computeSnapshot(db)
    })
    options.store.save(
      encode({
        version: 1,
        installationId,
        epoch,
        generation,
        snapshotHash: snapshotHash(snapshot),
        roster: snapshot.roster,
        provenance: [],
      })
    )
    return {
      installationId,
      epoch,
      generation,
      revokedCredentials: revoked,
      disabledConnectors: disabled,
    }
  } finally {
    lock?.release()
  }
}

export type CheckpointReport = {
  state: "uninitialized" | "ready" | "denied"
  reason?: DenyReason
  installationId?: string
  epoch?: string
  generation?: number
  signedChanges?: number
}

/** Read-only report for `status`: the record's identity and whether the database matches it. */
export function inspectControlCheckpoint(
  db: DatabaseSync,
  store: ControlStore
): CheckpointReport {
  let raw: string | undefined
  try {
    raw = store.load()
  } catch {
    return { state: "denied", reason: "store_unreadable" }
  }
  if (raw === undefined) return { state: "uninitialized" }
  const record = parseControlRecord(raw)
  if (record === undefined) return { state: "denied", reason: "store_malformed" }
  const identity = {
    installationId: record.installationId,
    epoch: record.epoch,
    generation: record.generation,
    signedChanges: record.provenance.length,
  }
  if (!reverify(record))
    return { state: "denied", reason: "reverify_failed", ...identity }
  if (snapshotHash(computeSnapshot(db)) !== record.snapshotHash)
    return { state: "denied", reason: "control_state_mismatch", ...identity }
  return { state: "ready", ...identity }
}
