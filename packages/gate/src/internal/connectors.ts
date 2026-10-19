import type { DatabaseSync } from "node:sqlite"
import { validateConnectorManifest } from "@eido/schemas"
import type {
  ConnectorManifest,
  ConnectorOperation,
  ConnectorTier,
} from "@eido/schemas"
import { append } from "./audit"
import { canonicalize, payloadHash } from "./canonical"
import {
  prepareControlApproval,
  withControlApproval,
} from "./control-approvals"
import type {
  ControlAuthorization,
  PreparedControlApproval,
} from "./control-approvals"

// Pinned connector manifests. The pinned manifest is the only description of a connector that
// policy reads: what a server says about its own tools (names, annotations) is never trusted.
// Control-plane changes require a signed local approval.

export type Drift = {
  drifted: boolean
  enabled: boolean
  added: string[]
  removed: string[]
}
type DriftDetails = Pick<Drift, "added" | "removed">

export type ConnectorState = {
  manifest: ConnectorManifest
  enabled: boolean
  drift: DriftDetails | null
}

export type EgressEntry = {
  connector: string
  host: string
  methods: string[]
  pathPrefixes: string[]
}

/** payloadHash (RFC 8785 canonical JSON, SHA-256) of the manifest. */
export function manifestHash(manifest: ConnectorManifest): string {
  return payloadHash(manifest)
}

function parseStored(json: string, hash: string): ConnectorManifest {
  const result = validateConnectorManifest(JSON.parse(json))
  if (!result.ok) {
    throw new Error(`stored connector manifest is invalid: ${result.errors[0]}`)
  }
  if (manifestHash(result.value) !== hash) {
    throw new Error("stored connector manifest does not match its hash")
  }
  return result.value
}

function parseDrift(value: unknown): DriftDetails | null {
  if (value === null) return null
  if (typeof value !== "string")
    throw new Error("stored connector drift is invalid")
  const parsed: unknown = JSON.parse(value)
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("added" in parsed) ||
    !("removed" in parsed) ||
    !Array.isArray(parsed.added) ||
    !parsed.added.every((name: unknown) => typeof name === "string") ||
    !Array.isArray(parsed.removed) ||
    !parsed.removed.every((name: unknown) => typeof name === "string")
  ) {
    throw new Error("stored connector drift is invalid")
  }
  return { added: parsed.added, removed: parsed.removed }
}

function storedRow(
  db: DatabaseSync,
  name: string
):
  | {
      manifest: ConnectorManifest
      hash: string
      enabled: boolean
      approvalRefHash: string | null
      drift: DriftDetails | null
    }
  | undefined {
  const row = db
    .prepare(
      "SELECT manifest_json, manifest_hash, enabled, pin_approval_ref_hash, drift_json FROM connectors WHERE name = ?"
    )
    .get(name)
  if (row === undefined) return undefined
  const hash = String(row["manifest_hash"])
  const approvalRefHash =
    typeof row["pin_approval_ref_hash"] === "string"
      ? row["pin_approval_ref_hash"]
      : null
  const pin = db
    .prepare(
      "SELECT detail_hash FROM audit_log WHERE action = 'connector.pinned' AND target = ? ORDER BY seq DESC LIMIT 1"
    )
    .get(name)
  // Migration disabled pre-approval pins and recorded the old hash before a signed pin could
  // exist. Keep that disabled row available for an owner's signed re-review.
  const unsignedMigration =
    pin === undefined &&
    approvalRefHash === null &&
    Number(row["enabled"]) === 0
      ? db
          .prepare(
            "SELECT detail_hash FROM audit_log WHERE action = 'connector.disabled_unsigned' AND target = ? ORDER BY seq DESC LIMIT 1"
          )
          .get(name)
      : undefined
  const expectedDetail =
    approvalRefHash === null
      ? hash
      : payloadHash({ manifestHash: hash, approvalRefHash })
  const migrated =
    unsignedMigration?.["detail_hash"] === payloadHash({ manifestHash: hash })
  if (
    (pin === undefined || pin["detail_hash"] !== expectedDetail) &&
    !migrated
  ) {
    throw new Error("stored connector manifest does not match its pin audit")
  }
  return {
    manifest: parseStored(String(row["manifest_json"]), hash),
    hash,
    enabled: Number(row["enabled"]) === 1,
    approvalRefHash,
    drift: parseDrift(row["drift_json"]),
  }
}

function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = work()
    db.exec("COMMIT")
    return result
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

/**
 * Validates and stores a manifest, enabling the connector and clearing any drift. Re-pinning a
 * changed manifest is the re-review path and needs a higher version than the one pinned; a
 * drift-disabled connector needs that too, so re-pinning the same manifest cannot re-enable it.
 * Appends `connector.pinned` with a detail binding the manifest and approval reference.
 */
export function pinManifest(
  db: DatabaseSync,
  manifest: unknown,
  actor: string,
  authorization?: ControlAuthorization
): void {
  const result = validateConnectorManifest(manifest)
  if (!result.ok) {
    throw new Error(`invalid connector manifest: ${result.errors.join("; ")}`)
  }
  const valid = result.value
  const hash = manifestHash(valid)
  withControlApproval(
    db,
    "manifest.pin",
    valid.name,
    hash,
    authorization,
    (approvalRefHash) => {
      const current = storedRow(db, valid.name)
      if (current !== undefined && valid.version <= current.manifest.version) {
        // A changed manifest is a new review, so it needs a new version. A drift-disabled
        // connector is re-enabled only by such a re-review, never by re-pinning the same manifest.
        if (current.hash !== hash) {
          throw new Error(
            `connector ${valid.name}: a changed manifest needs a version above ${current.manifest.version}`
          )
        }
        if (
          !current.enabled &&
          (current.approvalRefHash !== null || current.drift !== null)
        ) {
          throw new Error(
            `connector ${valid.name} is disabled after drift: pin a re-reviewed manifest with a version above ${current.manifest.version}`
          )
        }
      }
      db.prepare(
        `INSERT INTO connectors (name, manifest_json, manifest_hash, pinned_at, enabled, health, consecutive_failures, drift_json, pin_approval_ref_hash)
       VALUES (?, ?, ?, ?, 1, 'healthy', 0, NULL, ?)
       ON CONFLICT (name) DO UPDATE SET
         manifest_json = excluded.manifest_json,
         manifest_hash = excluded.manifest_hash,
         pinned_at = excluded.pinned_at,
         enabled = 1,
         health = 'healthy',
         consecutive_failures = 0,
         drift_json = NULL,
         pin_approval_ref_hash = excluded.pin_approval_ref_hash`
      ).run(
        valid.name,
        canonicalize(valid),
        hash,
        new Date().toISOString(),
        approvalRefHash
      )
      const audit = append(db, {
        actor,
        action: "connector.pinned",
        target: valid.name,
        detailHash: payloadHash({ manifestHash: hash, approvalRefHash }),
      })
      return { result: undefined, auditSeq: audit.seq }
    }
  )
}

/** Prepares the exact validated manifest for a local admin's signed review. */
export function prepareManifestPin(
  db: DatabaseSync,
  manifest: unknown
): PreparedControlApproval {
  const result = validateConnectorManifest(manifest)
  if (!result.ok)
    throw new Error(`invalid connector manifest: ${result.errors.join("; ")}`)
  return prepareControlApproval(
    db,
    "manifest.pin",
    result.value.name,
    result.value
  )
}

/** The active pinned manifest, or undefined when unpinned or disabled. */
export function getPinnedManifest(
  db: DatabaseSync,
  name: string
): ConnectorManifest | undefined {
  const row = storedRow(db, name)
  return row?.enabled ? row.manifest : undefined
}

/** Administrative state for re-review, including a disabled manifest and its last drift. */
export function getConnectorState(
  db: DatabaseSync,
  name: string
): ConnectorState | undefined {
  const row = storedRow(db, name)
  if (row === undefined) return undefined
  return { manifest: row.manifest, enabled: row.enabled, drift: row.drift }
}

/**
 * The pinned description of one operation. Undefined when the connector is not pinned, is
 * disabled, or its manifest has no such operation; policy (#11) treats undefined as forbidden.
 */
export function pinnedOperation(
  db: DatabaseSync,
  connector: string,
  operation: string
): ConnectorOperation | undefined {
  const row = storedRow(db, connector)
  if (row === undefined || !row.enabled) return undefined
  return row.manifest.operations.find((op) => op.name === operation)
}

/**
 * The connector and operation names that declare `intentKind` on enabled connectors only.
 */
export function intentBindings(
  db: DatabaseSync,
  intentKind: string
): Array<{ connector: string; operation: string }> {
  return db
    .prepare("SELECT name FROM connectors WHERE enabled = 1 ORDER BY name ASC")
    .all()
    .flatMap((row) => {
      const state = storedRow(db, String(row["name"]))
      if (state === undefined || !state.enabled) return []
      return state.manifest.operations
        .filter((op) => op.intentKind === intentKind)
        .map((op) => ({ connector: state.manifest.name, operation: op.name }))
    })
}

/** Whether a disabled connector declared this kind, without exposing its operation. */
export function hasDisabledIntentBinding(
  db: DatabaseSync,
  intentKind: string
): boolean {
  const rows = db
    .prepare("SELECT name FROM connectors WHERE enabled = 0 ORDER BY name ASC")
    .all()
  return rows.some((row) => {
    const state = storedRow(db, String(row["name"]))
    return (
      state !== undefined &&
      !state.enabled &&
      state.manifest.operations.some((op) => op.intentKind === intentKind)
    )
  })
}

/**
 * Compares the tool names a server reports with the pinned operation names. Any difference
 * disables the connector until it is pinned again. Each distinct observed drift is audited;
 * identical repeat observations do not append rows. Tool annotations are never trusted.
 */
export function checkDrift(
  db: DatabaseSync,
  name: string,
  observedToolNames: string[]
): Drift {
  return inTransaction(db, () => {
    const row = storedRow(db, name)
    if (row === undefined) {
      throw new Error(`connector ${name} is not pinned`)
    }
    const pinned = new Set(row.manifest.operations.map((op) => op.name))
    const observed = new Set(observedToolNames)
    const added = [...observed].filter((tool) => !pinned.has(tool)).sort()
    const removed = [...pinned].filter((tool) => !observed.has(tool)).sort()
    const drifted = added.length > 0 || removed.length > 0
    if (drifted) {
      const drift = { added, removed }
      if (row.enabled || canonicalize(row.drift) !== canonicalize(drift)) {
        db.prepare(
          "UPDATE connectors SET enabled = 0, drift_json = ? WHERE name = ?"
        ).run(canonicalize(drift), name)
        append(db, {
          actor: "system",
          action: row.enabled
            ? "connector.disabled_drift"
            : "connector.drift_changed",
          target: name,
          detailHash: payloadHash({ manifestHash: row.hash, ...drift }),
        })
      }
    }
    return { drifted, enabled: row.enabled && !drifted, added, removed }
  })
}

/**
 * The tier for one operation: the user's config entry when present, else the manifest default.
 * Config may loosen or tighten; the rule that `auto` needs a reversible operation and the
 * forbidden rules are enforced by policy (#11).
 */
export function resolveTier(
  manifestDefault: ConnectorTier,
  userOverride?: ConnectorTier
): ConnectorTier {
  return userOverride ?? manifestDefault
}

/** Egress entries of enabled connectors, the source of the proxy allowlist (#14). */
export function egressAllowlist(db: DatabaseSync): EgressEntry[] {
  const rows = db
    .prepare("SELECT name FROM connectors WHERE enabled = 1 ORDER BY name ASC")
    .all()
  return rows.flatMap((row) => {
    const state = storedRow(db, String(row["name"]))
    if (state === undefined || !state.enabled) return []
    return state.manifest.egress.hosts.map((entry) => ({
      connector: state.manifest.name,
      host: entry.host,
      methods: [...entry.methods],
      pathPrefixes: [...entry.pathPrefixes],
    }))
  })
}
