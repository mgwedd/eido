import {
  validateGateAuditChainStatus,
  validateGateBackupStatus,
  validateGateFileRoots,
  validateGatePasskeyList,
  validateGatePermissionList,
  type GateAuditChainStatus,
  type GateBackupStatus,
  type GateFileRoots,
  type GatePasskeyList,
  type GatePermissionList,
} from "@eido/schemas"

export type Passkey = GatePasskeyList["passkeys"][number]
export type PermissionTier = GatePermissionList["tiers"][number]
export type PermissionList = GatePermissionList
export type ChainStatus = GateAuditChainStatus
export type BackupStatus = GateBackupStatus
export type FileRoots = GateFileRoots
export type Tier = PermissionTier["tier"]

export const PASSKEYS_URL = "/api/gate/passkeys"
export const PERMISSIONS_URL = "/api/gate/permissions"
export const BACKUP_STATUS_URL = "/api/gate/backup/status"
export const AUDIT_CHAIN_URL = "/api/gate/audit/chain"
export const FILE_ROOTS_URL = "/api/gate/file-roots"

/** One section's read: data, a gate that cannot be reached, or a failed read. */
export type SectionLoad<T> =
  | { status: "ready"; value: T }
  | { status: "offline" }
  | { status: "unauthenticated" }
  | { status: "error" }

type Validated<T> =
  { ok: true; value: T } | { ok: false; errors: readonly unknown[] }

/**
 * Reads one gate endpoint. The response is never stored on the device (`passkeys`,
 * `permissions` and `audit` are sensitive): a network failure is "offline" and carries no
 * data; any other failure is an error.
 */
export async function loadSection<T>(
  url: string,
  validate: (input: unknown) => Validated<T>,
  signal: AbortSignal
): Promise<SectionLoad<T>> {
  try {
    const response = await fetch(url, { cache: "no-store", signal })
    if (response.status === 401) return { status: "unauthenticated" }
    if (!response.ok) return { status: "error" }
    const parsed = validate(await response.json())
    if (!parsed.ok) return { status: "error" }
    return { status: "ready", value: parsed.value }
  } catch (error) {
    if (!signal.aborted && error instanceof TypeError)
      return { status: "offline" }
    return { status: "error" }
  }
}

export const loadPasskeys = (signal: AbortSignal) =>
  loadSection(PASSKEYS_URL, validateGatePasskeyList, signal)
export const loadPermissions = (signal: AbortSignal) =>
  loadSection(PERMISSIONS_URL, validateGatePermissionList, signal)
export const loadBackupStatus = (signal: AbortSignal) =>
  loadSection(BACKUP_STATUS_URL, validateGateBackupStatus, signal)
export const loadAuditChain = (signal: AbortSignal) =>
  loadSection(AUDIT_CHAIN_URL, validateGateAuditChainStatus, signal)
export const loadFileRoots = (signal: AbortSignal) =>
  loadSection(FILE_ROOTS_URL, validateGateFileRoots, signal)

/** "1 allowed folder", "3 allowed folders", "No allowed folders". */
export function folderCount(count: number): string {
  if (count === 0) return "No allowed folders"
  return `${count} allowed ${count === 1 ? "folder" : "folders"}`
}

/** First eight hex characters of the credential fingerprint: enough to tell keys apart. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 8)
}

export function isRevoked(passkey: Passkey): boolean {
  return passkey.revokedAt !== null
}

export const TIER_LABELS: Readonly<Record<Tier, string>> = {
  auto: "Automatic",
  approval: "Needs approval",
  forbidden: "Forbidden",
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  unknown_kind: "The gate does not know this kind.",
  no_operation: "No connector operation backs this kind.",
  ambiguous_operation: "More than one connector operation backs this kind.",
  manifest_forbidden: "The pinned connector manifest forbids it.",
  root_not_allowed: "The path is outside the allowed folders.",
  connector_disabled: "Its connector is disabled.",
}

export function reasonLabel(reason: string | undefined): string | null {
  if (reason === undefined) return null
  return REASON_LABELS[reason] ?? reason
}

export function chainSummary(status: ChainStatus): string {
  if (status.ok)
    return status.rows === 1 ? "OK, 1 row" : `OK, ${status.rows} rows`
  return `Broken at sequence ${status.brokenAtSeq}`
}

const CHAIN_REASONS: Readonly<Record<string, string>> = {
  prev_hash_mismatch: "A row does not link to the one before it.",
  seq_gap: "A sequence number is missing.",
  bad_genesis: "The first row is not a valid start.",
  head_mismatch: "The stored head does not match the log.",
}

export function chainReason(status: ChainStatus): string | null {
  if (status.ok) return null
  return CHAIN_REASONS[status.reason] ?? status.reason
}

export type AboutInfo = { version: string; buildId: string | null }

/** Version and build id baked in at build time by next.config.ts; the build id is absent when none was available. */
export function aboutInfo(
  env: Readonly<Record<string, string | undefined>> = {
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
    NEXT_PUBLIC_BUILD_ID: process.env.NEXT_PUBLIC_BUILD_ID,
  }
): AboutInfo | null {
  const version = env["NEXT_PUBLIC_APP_VERSION"]
  if (!version) return null
  const buildId = env["NEXT_PUBLIC_BUILD_ID"]
  return { version, buildId: buildId ? buildId : null }
}
