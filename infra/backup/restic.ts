// The restic calls. restic is a binary the owner installs; the runner is injected so tests
// never need it. The passphrase is never read here: restic asks the Keychain itself through
// RESTIC_PASSWORD_COMMAND, so it is not in this process, a plist, an argument list or a log.
import { BackupError } from "./errors.ts"
import {
  KEYCHAIN,
  RETENTION,
  SNAPSHOT_HOST,
  SNAPSHOT_TAG,
  type BackupConfig,
} from "./config.ts"

export type ResticResult = { code: number; stdout: string; stderr: string }
/** Runs `restic <args>` with `env` on top of the inherited environment. */
export type ResticRun = (
  args: readonly string[],
  env: Readonly<Record<string, string>>
) => Promise<ResticResult>

export type Snapshot = { id: string; time: Date }

const PASSWORD_VARIABLES = [
  "RESTIC_PASSWORD",
  "RESTIC_PASSWORD_FILE",
  "RESTIC_PASSWORD_COMMAND",
] as const

/**
 * The variables restic is given: the repository, and unless the caller's environment already
 * names a passphrase source, a command that reads the passphrase from the login Keychain.
 */
export function resticEnv(
  config: BackupConfig,
  base: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const env: Record<string, string> = { RESTIC_REPOSITORY: config.repository }
  if (!PASSWORD_VARIABLES.some((name) => (base[name] ?? "") !== ""))
    env["RESTIC_PASSWORD_COMMAND"] =
      `/usr/bin/security find-generic-password -s ${KEYCHAIN.service} -a ${KEYCHAIN.account} -w`
  return env
}

export function backupArgs(
  config: BackupConfig,
  includeBlobs: boolean
): string[] {
  return [
    "backup",
    "--host",
    SNAPSHOT_HOST,
    "--tag",
    SNAPSHOT_TAG,
    // A blob is written under a temporary name and hard-linked into place; the temporary
    // name is never a stored original.
    "--exclude",
    "*.tmp",
    config.stagingDir,
    ...(includeBlobs ? [config.blobDir] : []),
  ]
}

export const forgetArgs = (): string[] => [
  "forget",
  "--host",
  SNAPSHOT_HOST,
  "--tag",
  SNAPSHOT_TAG,
  "--keep-daily",
  String(RETENTION.daily),
  "--keep-weekly",
  String(RETENTION.weekly),
  "--keep-monthly",
  String(RETENTION.monthly),
  "--prune",
]

export const snapshotsArgs = (): string[] => [
  "snapshots",
  "--json",
  "--host",
  SNAPSHOT_HOST,
  "--tag",
  SNAPSHOT_TAG,
]

export const restoreArgs = (snapshot: string, target: string): string[] => [
  "restore",
  snapshot,
  "--target",
  target,
]

/** The last lines of restic's stderr, for a log line when a call fails. */
export function tail(text: string, lines = 10): string {
  return text.trim().split("\n").slice(-lines).join(" | ")
}

export async function mustRun(
  run: ResticRun,
  args: readonly string[],
  env: Readonly<Record<string, string>>
): Promise<ResticResult> {
  const result = await run(args, env)
  if (result.code !== 0)
    throw new BackupError(
      `restic ${args[0] ?? ""} exited ${result.code}: ${tail(result.stderr)}`
    )
  return result
}

/** Snapshots oldest first, parsed from `restic snapshots --json`. */
export function parseSnapshots(json: string): Snapshot[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new BackupError("restic snapshots did not print JSON")
  }
  if (!Array.isArray(parsed))
    throw new BackupError("restic snapshots did not print a list")
  const snapshots = parsed.map((item: unknown): Snapshot => {
    if (typeof item !== "object" || item === null)
      throw new BackupError("restic snapshots listed a non-object")
    const id: unknown = "id" in item ? item.id : undefined
    const time: unknown = "time" in item ? item.time : undefined
    if (typeof id !== "string" || typeof time !== "string")
      throw new BackupError("a snapshot has no id or time")
    const date = new Date(time)
    if (Number.isNaN(date.getTime()))
      throw new BackupError(`a snapshot has an unreadable time`)
    return { id, time: date }
  })
  return snapshots.sort((a, b) => a.time.getTime() - b.time.getTime())
}
