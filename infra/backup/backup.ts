// The nightly job and its freshness check (#30). `runBackup`: take consistent copies of the
// SQLite files into a staging directory, back the copies and the blob store up with restic, apply
// the retention policy, then write the last-success stamp. `runCheck`: fail when the newest
// snapshot is older than 36 hours. Both fail loudly, never write outside the repository, and
// never create a repository: a missing or unmounted drive is an error.
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, sep } from "node:path"

import { MAX_SNAPSHOT_AGE_HOURS, type BackupConfig } from "./config.ts"
import { copyDatabase } from "./copy-database.ts"
import { BackupError } from "./errors.ts"
import {
  backupArgs,
  forgetArgs,
  mustRun,
  parseSnapshots,
  resticEnv,
  snapshotsArgs,
  type ResticRun,
  type Snapshot,
} from "./restic.ts"

export type Deps = {
  run: ResticRun
  now: () => Date
  log: (line: string) => void
  /** The caller's environment, read only for a passphrase source already set in it. */
  env: Readonly<Record<string, string | undefined>>
}

const VOLUMES = `${sep}Volumes${sep}`

/** Throws unless the repository's drive is mounted and the repository was initialised on it. */
export function assertRepositoryReachable(config: BackupConfig): void {
  if (config.repository.startsWith(VOLUMES)) {
    const volume = join(
      VOLUMES,
      config.repository.slice(VOLUMES.length).split(sep)[0] ?? ""
    )
    if (!existsSync(volume))
      throw new BackupError(
        `backup drive not mounted: ${volume} does not exist; plug it in`
      )
  }
  if (!existsSync(join(config.repository, "config")))
    throw new BackupError(
      `no restic repository at ${config.repository}: the drive is missing, or run "restic init" once (see infra/README.md)`
    )
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

/** Writes the stamp through a rename, so a reader never sees half a timestamp. */
function writeStamp(path: string, when: Date): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${when.toISOString()}\n`)
  renameSync(temp, path)
}

export async function runBackup(
  config: BackupConfig,
  deps: Deps
): Promise<void> {
  const { log } = deps
  const env = resticEnv(config, deps.env)
  log("backup start")
  assertRepositoryReachable(config)
  rmSync(config.stagingDir, { recursive: true, force: true })
  mkdirSync(config.stagingDir, { recursive: true, mode: 0o700 })
  try {
    for (const db of config.databases) {
      copyDatabase(db.path, db.staged)
      log(`copied ${db.name}: integrity_check ok`)
    }
    const hasBlobs = isDirectory(config.blobDir)
    if (!hasBlobs) log("no blob store yet; backing up the databases only")
    await mustRun(deps.run, backupArgs(config, hasBlobs), env)
    log("snapshot written")
    await mustRun(deps.run, forgetArgs(), env)
    log("retention applied: 7 daily, 4 weekly, 6 monthly")
  } finally {
    // The staged copies are plaintext; they do not outlive the run.
    rmSync(config.stagingDir, { recursive: true, force: true })
  }
  writeStamp(config.stampFile, deps.now())
  log("backup ok")
}

export async function listSnapshots(
  config: BackupConfig,
  deps: Deps
): Promise<Snapshot[]> {
  assertRepositoryReachable(config)
  const result = await mustRun(
    deps.run,
    snapshotsArgs(),
    resticEnv(config, deps.env)
  )
  return parseSnapshots(result.stdout)
}

/** Throws unless the newest snapshot is at most 36 hours old. Returns what it found. */
export async function runCheck(
  config: BackupConfig,
  deps: Deps
): Promise<{ id: string; ageHours: number }> {
  const snapshots = await listSnapshots(config, deps)
  const newest = snapshots.at(-1)
  if (newest === undefined)
    throw new BackupError("the repository has no snapshots")
  const ageHours = (deps.now().getTime() - newest.time.getTime()) / 3_600_000
  if (ageHours > MAX_SNAPSHOT_AGE_HOURS)
    throw new BackupError(
      `newest snapshot ${newest.id} is ${Math.floor(ageHours)} hours old (limit ${MAX_SNAPSHOT_AGE_HOURS})`
    )
  return { id: newest.id, ageHours }
}
