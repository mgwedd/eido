import { createHash } from "node:crypto"
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { INTENT_KINDS } from "@eido/schemas"
import type { ConnectorOperation, ConnectorTier, Intent } from "@eido/schemas"
import { append } from "./audit"
import { canonicalize, payloadHash } from "./canonical"
import {
  approvedControlValue,
  prepareControlApproval,
  withControlApproval,
} from "./control-approvals"
import type {
  ControlAuthorization,
  PreparedControlApproval,
} from "./control-approvals"
import { intentBindings, pinnedOperation } from "./connectors"

// The permission table. The gate ships a versioned default; a signed owner override
// changes the tier of single kinds. Effective tier: overlay entry, else shipped entry,
// else the pinned operation's defaultTier. Guards that no config can lift: auto needs an
// operation the pinned manifest marks reversible, a kind with no pinned operation is forbidden,
// guests other than the owner force approval, and a file root outside the allowed list is
// forbidden. Operations are read only through pinnedOperation, so a disabled connector exposes
// nothing.

export type IntentKind = Intent["kind"]
export type Tier = ConnectorTier
export type ConfigTier = "auto" | "approval"
export type PermissionTable = {
  version: number
  tiers: Partial<Record<IntentKind, ConfigTier>>
}

export type PolicyOptions = {
  /** The gate's data dir; the overlay is `permissions.json` in it. */
  dataDir: string
  /** The owner's own addresses; any other calendar guest forces approval. */
  ownerAddresses: readonly string[]
  /** Allowed-folder ids a file intent's `root` may name. */
  allowedRoots: readonly string[]
  /** The shipped default table; tests point this at a fixture. */
  shippedPath?: string | URL
}

export type Policy = {
  shipped: PermissionTable
  overlay: PermissionTable | undefined
  ownerAddresses: readonly string[]
  allowedRoots: readonly string[]
}

export type ForbiddenReason =
  | "unknown_kind"
  | "no_operation"
  | "ambiguous_operation"
  | "manifest_forbidden"
  | "root_not_allowed"
  | "connector_disabled"

export type TierDecision =
  { tier: ConfigTier } | { tier: "forbidden"; reason: ForbiddenReason }

export const SHIPPED_DEFAULT_PATH = new URL(
  "../../config/permissions.default.json",
  import.meta.url
)
export const OVERLAY_FILE = "permissions.json"

const KINDS: ReadonlySet<string> = new Set(INTENT_KINDS)

function isIntentKind(kind: string): kind is IntentKind {
  return KINDS.has(kind)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function forbidden(reason: ForbiddenReason): TierDecision {
  return { tier: "forbidden", reason }
}

type OperationLookup =
  | { status: "ok"; operation: ConnectorOperation }
  | { status: "none" | "ambiguous" | "disabled" }

function lookupOperation(db: DatabaseSync, kind: string): OperationLookup {
  const bindings = intentBindings(db, kind)
  const [binding, ...others] = bindings
  if (binding === undefined) return { status: "none" }
  // Two connectors claiming one kind leave the target unclear: refuse rather than guess.
  if (others.length > 0) return { status: "ambiguous" }
  const operation = pinnedOperation(db, binding.connector, binding.operation)
  return operation === undefined
    ? { status: "disabled" }
    : { status: "ok", operation }
}

/** The tier of a kind before any payload rule. */
export function kindTier(
  db: DatabaseSync,
  policy: Policy,
  kind: string
): TierDecision {
  if (!isIntentKind(kind)) return forbidden("unknown_kind")
  const lookup = lookupOperation(db, kind)
  switch (lookup.status) {
    case "none":
      return forbidden("no_operation")
    case "ambiguous":
      return forbidden("ambiguous_operation")
    case "disabled":
      return forbidden("connector_disabled")
    case "ok":
      break
  }
  const { operation } = lookup
  // resolveTier (#10) lets config override the manifest default; a manifest forbidden is final.
  if (operation.defaultTier === "forbidden") {
    return forbidden("manifest_forbidden")
  }
  const configured: ConfigTier =
    policy.overlay?.tiers[kind] ??
    policy.shipped.tiers[kind] ??
    operation.defaultTier
  if (configured === "auto" && operation.reversibility !== "reversible") {
    return { tier: "approval" }
  }
  return { tier: configured }
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase()
}

function hasOtherGuest(
  guests: readonly string[] | undefined,
  owner: readonly string[]
): boolean {
  const own = new Set(owner.map(normalizeAddress))
  return (guests ?? []).some((guest) => !own.has(normalizeAddress(guest)))
}

/** The tier of one validated intent: the kind's tier, then the payload rules in code. */
export function intentTier(
  db: DatabaseSync,
  policy: Policy,
  intent: Intent
): TierDecision {
  const decision = kindTier(db, policy, intent.kind)
  if (decision.tier === "forbidden") return decision
  switch (intent.kind) {
    case "file.create":
    case "file.rename":
    case "file.move":
    case "file.delete":
      return policy.allowedRoots.includes(intent.args.root)
        ? decision
        : forbidden("root_not_allowed")
    case "calendar.create":
    case "calendar.edit":
      return hasOtherGuest(intent.args.guests, policy.ownerAddresses)
        ? { tier: "approval" }
        : decision
    default:
      return decision
  }
}

type TableResult =
  { ok: true; table: PermissionTable } | { ok: false; errors: string[] }

/**
 * Validates a permission table. With `db`, an `auto` entry also needs an operation the pinned
 * manifest marks reversible (the overlay guard); the shipped default is checked without it.
 */
function parseTable(
  value: unknown,
  source: string,
  db?: DatabaseSync
): TableResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [`${source}: expected an object with version and tiers`],
    }
  }
  const errors: string[] = []
  for (const key of Object.keys(value)) {
    if (key !== "version" && key !== "tiers") {
      errors.push(`${source}: unknown key ${JSON.stringify(key)}`)
    }
  }
  const { version, tiers } = value
  const validVersion =
    typeof version === "number" && Number.isInteger(version) && version >= 1
  if (!validVersion) {
    errors.push(`${source}: version must be a positive integer`)
  }
  if (!isRecord(tiers)) {
    errors.push(`${source}: tiers must be an object`)
    return { ok: false, errors }
  }
  const table: Partial<Record<IntentKind, ConfigTier>> = {}
  for (const [kind, tier] of Object.entries(tiers)) {
    const name = JSON.stringify(kind)
    if (!isIntentKind(kind)) {
      errors.push(`${source}: ${name}: unknown intent kind`)
    } else if (tier !== "auto" && tier !== "approval") {
      errors.push(
        `${source}: ${name}: tier must be "auto" or "approval" (forbidden is not configurable)`
      )
    } else if (tier === "auto" && db !== undefined && !reversible(db, kind)) {
      errors.push(
        `${source}: ${name}: auto needs an operation the pinned manifest marks reversible`
      )
    } else {
      table[kind] = tier
    }
  }
  if (errors.length > 0 || typeof version !== "number") {
    return { ok: false, errors }
  }
  return { ok: true, table: { version, tiers: table } }
}

function reversible(db: DatabaseSync, kind: IntentKind): boolean {
  const lookup = lookupOperation(db, kind)
  return (
    lookup.status === "ok" && lookup.operation.reversibility === "reversible"
  )
}

function readShipped(path: string | URL): PermissionTable {
  const result = parseTable(
    JSON.parse(readFileSync(path, "utf8")),
    "permissions.default.json"
  )
  if (!result.ok) {
    throw new Error(
      `invalid shipped permission table: ${result.errors.join("; ")}`
    )
  }
  return result.table
}

type OverlayRead =
  | { status: "absent" }
  | { status: "ok"; table: PermissionTable }
  | { status: "rejected"; errors: string[]; fileHash: string }

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

/** Why the overlay file may not be trusted, or undefined when it may. */
function ownershipError(mode: number, uid: number): string | undefined {
  // Windows has no POSIX owner or mode bits; there the data dir's ACL is the control.
  if (process.platform === "win32") return undefined
  if ((mode & 0o022) !== 0) {
    return `${OVERLAY_FILE}: writable by group or others; only the gate user may write it`
  }
  const gateUid = process.getuid?.()
  if (gateUid !== undefined && uid !== gateUid) {
    return `${OVERLAY_FILE}: not owned by the gate user`
  }
  return undefined
}

function readOverlay(db: DatabaseSync, path: string): OverlayRead {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch (error) {
    if (isMissingFile(error)) return { status: "absent" }
    throw error
  }
  let raw: Buffer
  let ownership: string | undefined
  try {
    const stat = fstatSync(fd)
    ownership = ownershipError(stat.mode, stat.uid)
    raw = readFileSync(fd)
  } finally {
    closeSync(fd)
  }
  const fileHash = createHash("sha256").update(raw).digest("hex")
  if (ownership !== undefined) {
    return { status: "rejected", errors: [ownership], fileHash }
  }
  let value: unknown
  try {
    value = JSON.parse(raw.toString("utf8"))
  } catch {
    return {
      status: "rejected",
      errors: [`${OVERLAY_FILE}: not valid JSON`],
      fileHash,
    }
  }
  const result = parseTable(value, OVERLAY_FILE, db)
  return result.ok
    ? { status: "ok", table: result.table }
    : { status: "rejected", errors: result.errors, fileHash }
}

function configHash(
  shipped: PermissionTable,
  overlay: PermissionTable | undefined
): string {
  return payloadHash({ shipped, overlay: overlay ?? null })
}

function approvedOverlay(db: DatabaseSync): PermissionTable | undefined {
  const row = db
    .prepare(
      "SELECT payload_json, payload_hash, approval_id FROM approved_policy WHERE singleton = 1"
    )
    .get()
  if (row === undefined) {
    // Deleting the active pointer must not roll back a previously approved policy.
    if (
      db
        .prepare(
          "SELECT id FROM control_approvals WHERE purpose = 'policy.set' AND used_at IS NOT NULL LIMIT 1"
        )
        .get() !== undefined
    )
      throw new Error("approved policy is missing")
    return undefined
  }
  const parsed: unknown = JSON.parse(String(row["payload_json"]))
  const result = parseTable(parsed, "approved policy")
  if (!result.ok) throw new Error("invalid approved policy")
  const hash = payloadHash(result.table)
  if (
    canonicalize(result.table) !== row["payload_json"] ||
    hash !== row["payload_hash"] ||
    !approvedControlValue(
      db,
      String(row["approval_id"]),
      "policy.set",
      "permissions",
      hash,
      "policy.changed",
      (approvalRefHash) => payloadHash({ policyHash: hash, approvalRefHash })
    )
  )
    throw new Error("approved policy does not match its signed approval")
  // The latest accepted policy is authoritative: an old signed row is not a rollback token.
  const latest = db
    .prepare(
      "SELECT id FROM control_approvals WHERE purpose = 'policy.set' AND used_at IS NOT NULL ORDER BY audit_seq DESC LIMIT 1"
    )
    .get()
  if (latest?.["id"] !== row["approval_id"])
    throw new Error("approved policy is stale")
  return result.table
}

function validatedChange(db: DatabaseSync, value: unknown): PermissionTable {
  const result = parseTable(value, OVERLAY_FILE, db)
  if (!result.ok)
    throw new Error(`invalid policy change: ${result.errors.join("; ")}`)
  return result.table
}

/** Prepares a proposed override; preparation never changes effective permissions. */
export function preparePolicyChange(
  db: DatabaseSync,
  value: unknown
): PreparedControlApproval {
  return prepareControlApproval(
    db,
    "policy.set",
    "permissions",
    validatedChange(db, value)
  )
}

/** Applies the exact signed table; an empty tiers object is the signed reset operation. */
export function setPolicyOverrides(
  db: DatabaseSync,
  value: unknown,
  actor: string,
  authorization?: ControlAuthorization
): PermissionTable {
  const table = validatedChange(db, value)
  const hash = payloadHash(table)
  return withControlApproval(
    db,
    "policy.set",
    "permissions",
    hash,
    authorization,
    (approvalRefHash, approvalId) => {
      db.prepare(
        "INSERT INTO approved_policy (singleton, payload_json, payload_hash, approval_id) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET payload_json = excluded.payload_json, payload_hash = excluded.payload_hash, approval_id = excluded.approval_id"
      ).run(canonicalize(table), hash, approvalId)
      const audit = append(db, {
        actor,
        action: "policy.changed",
        target: "permissions",
        detailHash: payloadHash({ policyHash: hash, approvalRefHash }),
      })
      return { result: table, auditSeq: audit.seq }
    }
  )
}

/** Loads only approved DB overrides. The owner-only file is a proposal, never authorization. */
export function loadPolicy(
  db: DatabaseSync,
  options: PolicyOptions,
  previous?: Policy
): { policy: Policy; errors: string[] } {
  const shipped = readShipped(options.shippedPath ?? SHIPPED_DEFAULT_PATH)
  const overlay = approvedOverlay(db)
  const policy: Policy = {
    shipped,
    overlay,
    ownerAddresses: [...options.ownerAddresses],
    allowedRoots: [...options.allowedRoots],
  }
  const path = join(options.dataDir, OVERLAY_FILE)
  const read = readOverlay(db, path)
  const errors =
    read.status === "rejected"
      ? read.errors
      : read.status === "ok" &&
          payloadHash(read.table) !== payloadHash(overlay ?? null)
        ? [`${OVERLAY_FILE}: a changed proposal requires a signed approval`]
        : []
  if (errors.length > 0) {
    const fileHash =
      read.status === "rejected"
        ? read.fileHash
        : payloadHash(read.status === "ok" ? read.table : null)
    append(db, {
      actor: "system",
      action: "policy.rejected",
      target: path,
      detailHash: payloadHash({ file_hash: fileHash, errors }),
    })
  }
  if (previous === undefined)
    append(db, {
      actor: "system",
      action: "policy.loaded",
      target: path,
      detailHash: payloadHash({ after_hash: configHash(shipped, overlay) }),
    })
  return {
    policy:
      errors.length > 0 &&
      previous !== undefined &&
      payloadHash(previous.overlay ?? null) === payloadHash(overlay ?? null)
        ? previous
        : policy,
    errors,
  }
}
