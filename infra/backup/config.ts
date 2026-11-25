// The backup's one typed config (#30): which files are backed up, where the repository and the
// staging copies live, and how long snapshots are kept. Data paths are not restated here: they
// come from the stack config (`../stack/config.ts`), so a changed EIDO_DATA_DIR or
// EIDO_GATE_DATA_DIR moves the backup with it. Nothing here is a secret; the repository
// passphrase is never part of the config (see `resticEnv`). `EIDO_BACKUP_PLANE=split` selects the
// plane's directories instead (#782).
import { isAbsolute, join, posix } from "node:path"

import { PLANE_LOGS, PLANE_ROOT } from "../host/plane.ts"
import { buildStackConfig, type Env } from "../stack/config.ts"
import { BackupError } from "./errors.ts"

// Core and gate own these names (`DATA_DB_FILE` in packages/core/src/main.ts, `CONTROL_DB_FILE`
// in packages/gate/src/main.ts); infra may not import either package.
export const DATA_DB_FILE = "eido-data.db"
export const CONTROL_DB_FILE = "eido-control.db"

export const OVERRIDES = [
  "EIDO_BACKUP_REPO",
  "EIDO_BACKUP_LOG_DIR",
  "EIDO_BACKUP_PLANE",
] as const

// The plane's directories (#70, infra/host/plane.ts `planeLayout`). They are fixed paths outside
// every home, so the backup does not need the owner's name to find them; a test holds them equal
// to the layout's. `backup` is the root daemon's own directory: root-owned, 0700, so neither
// service user can read the staged copies or the passphrase file.
export const PLANE_GATE_DIR = `${PLANE_ROOT}/gate`
export const PLANE_DATA_DIR = `${PLANE_ROOT}/data`
export const PLANE_BACKUP_DIR = `${PLANE_ROOT}/backup`
export const PLANE_BACKUP_LOG_DIR = `${PLANE_LOGS}/backup`

/** Retention: 7 daily, 4 weekly and 6 monthly snapshots are kept; the rest are pruned. */
export const RETENTION = { daily: 7, weekly: 4, monthly: 6 } as const

/** `check` fails when the newest snapshot is older than this. */
export const MAX_SNAPSHOT_AGE_HOURS = 36

/** The Keychain item that holds the repository passphrase. */
export const KEYCHAIN = { service: "eido-backup", account: "restic" } as const

/** Snapshots carry these so retention and `check` only ever look at Eido's own. */
export const SNAPSHOT_HOST = "eido"
export const SNAPSHOT_TAG = "eido-nightly"

export type BackupConfig = {
  /** `split`: the databases are the plane's, backed up by a root LaunchDaemon (#782). */
  plane: "single" | "split"
  /** SQLite files, backed up as consistent copies taken into `stagingDir`. */
  databases: { name: string; path: string; staged: string }[]
  /** Originals by content hash; immutable files, backed up in place. */
  blobDir: string
  /** Holds the consistent database copies for the length of one run; removed afterwards. */
  stagingDir: string
  /** The restic repository: an absolute path on a local drive. */
  repository: string
  logDir: string
  /** Rewritten with the time of each fully successful run. */
  stampFile: string
  /** Split host only: the root-only file that holds the repository passphrase. */
  passwordFile?: string
}

export type BackupConfigInput = {
  env: Env
  home: string
  repoRoot: string
}

/**
 * The backup of a split host (#782): the gate's and data plane's directories as `_eidogate` and
 * `_eidodata` own them, copied by a root daemon that keeps its staging directory, passphrase file
 * and log inside root-only directories.
 */
export function planeBackupConfig(repository: string): BackupConfig {
  const stagingDir = `${PLANE_BACKUP_DIR}/staging`
  const database = (name: string, dir: string) => ({
    name,
    path: posix.join(dir, name),
    staged: posix.join(stagingDir, name),
  })
  return {
    plane: "split",
    databases: [
      database(DATA_DB_FILE, PLANE_DATA_DIR),
      database(CONTROL_DB_FILE, PLANE_GATE_DIR),
    ],
    blobDir: posix.join(PLANE_DATA_DIR, "blobs"),
    stagingDir,
    repository,
    logDir: PLANE_BACKUP_LOG_DIR,
    // The gate reads the stamp for its backup status, so it sits where the gate user can read it.
    stampFile: posix.join(PLANE_LOGS, "backup-last-success"),
    passwordFile: `${PLANE_BACKUP_DIR}/restic-password`,
  }
}

export function buildBackupConfig(input: BackupConfigInput): BackupConfig {
  const repository = input.env["EIDO_BACKUP_REPO"]
  if (repository === undefined || repository === "")
    throw new BackupError(
      "EIDO_BACKUP_REPO must name the restic repository, an absolute path on the backup drive"
    )
  if (!isAbsolute(repository))
    throw new BackupError(
      `EIDO_BACKUP_REPO must be an absolute local path, not ${JSON.stringify(repository)}`
    )
  const plane = input.env["EIDO_BACKUP_PLANE"] ?? ""
  if (plane !== "" && plane !== "single" && plane !== "split")
    throw new BackupError(
      `EIDO_BACKUP_PLANE must be "single" or "split", not ${JSON.stringify(plane)}`
    )
  if (plane === "split") return planeBackupConfig(repository)

  // Only the data directories are read from the stack config; the host and mode are not used.
  const stack = buildStackConfig({
    mode: "prod",
    env: input.env,
    home: input.home,
    repoRoot: input.repoRoot,
    nodePath: process.execPath,
    tailnetHost: "localhost",
  })
  const gateDir = stack.processes.find((p) => p.name === "gate")?.env[
    "EIDO_GATE_DATA_DIR"
  ]
  const coreDir = stack.processes.find((p) => p.name === "core")?.env[
    "EIDO_DATA_DIR"
  ]
  if (gateDir === undefined || coreDir === undefined)
    throw new Error("the stack config names no gate or core data directory")

  const stagingDir = join(stack.stackDir, "backup-staging")
  const logOverride = input.env["EIDO_BACKUP_LOG_DIR"]
  const logDir =
    logOverride === undefined || logOverride === ""
      ? join(input.home, "Library", "Logs", "eido")
      : logOverride
  const database = (name: string, dir: string) => ({
    name,
    path: join(dir, name),
    staged: join(stagingDir, name),
  })
  return {
    plane: "single",
    databases: [
      database(DATA_DB_FILE, coreDir),
      database(CONTROL_DB_FILE, gateDir),
    ],
    blobDir: join(coreDir, "blobs"),
    stagingDir,
    repository,
    logDir,
    stampFile: join(logDir, "backup-last-success"),
  }
}
