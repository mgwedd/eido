import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { validateConnectorManifest } from "@eido/schemas"
import type { ConnectorManifest } from "@eido/schemas"
import {
  controlApprovalChallenge,
  type ControlAuthorization,
} from "./control-approvals"
import {
  getConnectorState,
  manifestHash,
  pinManifest,
  prepareManifestPin,
} from "./connectors"

// Re-pinning a drift-disabled connector (#97). It is a signed `manifest.pin` control change,
// not an executor intent: the owner reviews the new manifest, and only a passkey assertion
// over its hash changes the pin. The reviewed manifest is a file the owner places on the Mac
// (`reviewed-manifests/<connector>.json` in the gate's data dir); the phone never supplies it.

export type RepinPrepared = {
  id: string
  purpose: "manifest.pin"
  target: string
  payload: string
  payloadHash: string
  nonce: string
  challenge: string
}

export type RepinRefusal =
  | "not_found"
  | "not_drifted"
  | "no_reviewed_manifest"
  | "invalid_manifest"
  | "mismatch"

type Checked =
  { ok: true; manifest: ConnectorManifest } | { ok: false; code: RepinRefusal }

/**
 * The reviewed manifest, when it can replace the pin of this drifted connector: same name, a
 * higher version, and exactly the tool names the server reported (the pinned names, less the
 * removed, plus the added). The names tie what is signed to the drift the owner was shown.
 */
function checkReviewed(
  db: DatabaseSync,
  name: string,
  reviewed: unknown
): Checked {
  const current = getConnectorState(db, name)
  if (current === undefined) return { ok: false, code: "not_found" }
  if (current.enabled || current.drift === null)
    return { ok: false, code: "not_drifted" }
  if (reviewed === undefined) return { ok: false, code: "no_reviewed_manifest" }
  const checked = validateConnectorManifest(reviewed)
  if (!checked.ok) return { ok: false, code: "invalid_manifest" }
  const manifest = checked.value
  if (manifest.name !== name || manifest.version <= current.manifest.version)
    return { ok: false, code: "invalid_manifest" }
  const observed = new Set(
    current.manifest.operations
      .map((op) => op.name)
      .filter((tool) => !current.drift?.removed.includes(tool))
  )
  for (const tool of current.drift.added) observed.add(tool)
  const proposed = new Set(manifest.operations.map((op) => op.name))
  if (
    proposed.size !== observed.size ||
    [...proposed].some((tool) => !observed.has(tool))
  )
    return { ok: false, code: "mismatch" }
  return { ok: true, manifest }
}

/** Starts the ceremony. Changes no pin and no connector state; a new call supersedes an old card. */
export function prepareRepin(
  db: DatabaseSync,
  name: string,
  reviewed: unknown
): { ok: true; prepared: RepinPrepared } | { ok: false; code: RepinRefusal } {
  const checked = checkReviewed(db, name, reviewed)
  if (!checked.ok) return checked
  return { ok: true, prepared: ceremony(db, checked.manifest) }
}

/** Prepares the signed `manifest.pin` ceremony over a checked manifest. */
function ceremony(
  db: DatabaseSync,
  manifest: ConnectorManifest
): RepinPrepared {
  const prepared = prepareManifestPin(db, manifest)
  return {
    id: prepared.id,
    purpose: "manifest.pin",
    target: prepared.target,
    payload: prepared.payload,
    payloadHash: prepared.payloadHash,
    nonce: prepared.nonce,
    challenge: controlApprovalChallenge(prepared),
  }
}

/**
 * Pins the reviewed manifest and re-enables the connector, only when the passkey assertion
 * verifies over the prepared hash. Any failure leaves the old pin and the connector disabled.
 */
export function applyRepin(
  db: DatabaseSync,
  name: string,
  reviewed: unknown,
  authorization: ControlAuthorization
):
  | { ok: true; manifestHash: string }
  | { ok: false; code: RepinRefusal | "refused" } {
  const checked = checkReviewed(db, name, reviewed)
  if (!checked.ok) return checked
  try {
    pinManifest(db, checked.manifest, "owner", authorization)
  } catch {
    return { ok: false, code: "refused" }
  }
  return { ok: true, manifestHash: manifestHash(checked.manifest) }
}

// First pin (#627): a connector with no row at all, on a fresh install. The same signed
// `manifest.pin` ceremony over the reviewed manifest the owner placed on the Mac; it applies
// only while no row exists for the name, so it can never replace or re-enable an existing pin.

export type FirstPinRefusal =
  "already_pinned" | "no_reviewed_manifest" | "invalid_manifest"

type FirstPinChecked =
  | { ok: true; manifest: ConnectorManifest }
  | { ok: false; code: FirstPinRefusal }

function pinned(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM connectors WHERE name = ?").get(name) !==
    undefined
  )
}

/** The reviewed manifest, when it can be the first pin of this name: valid and of the same name. */
function checkFirst(
  db: DatabaseSync,
  name: string,
  reviewed: unknown
): FirstPinChecked {
  if (pinned(db, name)) return { ok: false, code: "already_pinned" }
  if (reviewed === undefined) return { ok: false, code: "no_reviewed_manifest" }
  const checked = validateConnectorManifest(reviewed)
  if (!checked.ok || checked.value.name !== name)
    return { ok: false, code: "invalid_manifest" }
  return { ok: true, manifest: checked.value }
}

/** Starts a first pin. Changes no connector state; a new call supersedes an old card. */
export function prepareFirstPin(
  db: DatabaseSync,
  name: string,
  reviewed: unknown
):
  { ok: true; prepared: RepinPrepared } | { ok: false; code: FirstPinRefusal } {
  const checked = checkFirst(db, name, reviewed)
  if (!checked.ok) return checked
  return { ok: true, prepared: ceremony(db, checked.manifest) }
}

/**
 * Pins the reviewed manifest of a never-pinned connector, only when the passkey assertion
 * verifies over the prepared hash and still no row exists. Any failure changes nothing.
 */
export function applyFirstPin(
  db: DatabaseSync,
  name: string,
  reviewed: unknown,
  authorization: ControlAuthorization
):
  | { ok: true; manifestHash: string }
  | { ok: false; code: FirstPinRefusal | "refused" } {
  const checked = checkFirst(db, name, reviewed)
  if (!checked.ok) return checked
  try {
    pinManifest(db, checked.manifest, "owner", authorization, {
      firstPin: true,
    })
  } catch {
    return { ok: false, code: "refused" }
  }
  return { ok: true, manifestHash: manifestHash(checked.manifest) }
}

/**
 * The placed reviewed manifests that could be a first pin: valid, named as their file, and with
 * no connector row. Listed by name with their tool names and scopes, which the owner reviews
 * before signing.
 */
export function unpinnedReviewed(
  db: DatabaseSync,
  names: readonly string[],
  read: (connector: string) => unknown
): Array<{ name: string; operations: string[]; scopes: string[] }> {
  return [...new Set(names)].sort().flatMap((name) => {
    const checked = checkFirst(db, name, read(name))
    if (!checked.ok) return []
    return [
      {
        name,
        operations: checked.manifest.operations.map((op) => op.name),
        scopes: [...checked.manifest.auth.scopes],
      },
    ]
  })
}

export const REVIEWED_MANIFEST_DIR = "reviewed-manifests"

const CONNECTOR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** The connector names with a reviewed manifest file placed; empty when the directory is absent. */
export function listReviewedManifests(dataDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(join(dataDir, REVIEWED_MANIFEST_DIR))
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter((name) => CONNECTOR_NAME.test(name))
    .sort()
}

/**
 * The owner's reviewed manifest for a connector: undefined when no file is placed, `null` when
 * the file is not JSON (the manifest check then refuses it). Only names that cannot leave the
 * directory are read.
 */
export function readReviewedManifest(
  dataDir: string,
  connector: string
): unknown {
  if (!CONNECTOR_NAME.test(connector)) return undefined
  let text: string
  try {
    text = readFileSync(
      join(dataDir, REVIEWED_MANIFEST_DIR, `${connector}.json`),
      "utf8"
    )
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
