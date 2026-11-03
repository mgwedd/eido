// The restore drill (#30): restore a snapshot into a scratch directory, then verify what came
// back. Nothing here touches the live data: restic writes under the target, at each file's
// original absolute path. Output is pass or fail, counts and timings, never contents.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"

import { CONTROL_DB_FILE, type BackupConfig } from "./config.ts"
import { verifyAuditChain } from "./audit-chain.ts"
import { integrityCheck } from "./copy-database.ts"
import { listSnapshots, type Deps } from "./backup.ts"
import { BackupError } from "./errors.ts"
import { mustRun, resticEnv, restoreArgs } from "./restic.ts"

export type Check = { name: string; ok: boolean; detail: string }

const SHA256 = /^[0-9a-f]{64}$/

function checkDatabase(path: string, name: string): Check[] {
  if (!existsSync(path))
    return [{ name: `${name} present`, ok: false, detail: "missing" }]
  let db: DatabaseSync | undefined
  try {
    // A file that is not a database only fails at the first query, not at open.
    db = new DatabaseSync(path, { readOnly: true })
    const integrity = integrityCheck(db)
    const checks: Check[] = [
      {
        name: `${name} integrity_check`,
        ok: integrity === "ok",
        detail: integrity,
      },
    ]
    if (name === CONTROL_DB_FILE) {
      const chain = verifyAuditChain(db)
      checks.push({
        name: "audit chain",
        ok: chain.ok,
        detail: chain.ok
          ? `${chain.rows} rows verified from seq 1`
          : `broken at seq ${chain.brokenAtSeq}: ${chain.reason}`,
      })
    }
    return checks
  } catch {
    return [
      {
        name: `${name} opens`,
        ok: false,
        detail: "not a readable SQLite database",
      },
    ]
  } finally {
    db?.close()
  }
}

/** Every file under `<blobDir>/<xx>/` must be named by its own SHA-256 and sit in the `xx` directory. */
function checkBlobs(blobDir: string): Check {
  if (!existsSync(blobDir))
    return {
      name: "blobs",
      ok: true,
      detail: "0 blobs (the snapshot has no blob store)",
    }
  let count = 0
  const bad: string[] = []
  for (const shard of readdirSync(blobDir, { withFileTypes: true })) {
    if (!shard.isDirectory()) {
      bad.push(shard.name)
      continue
    }
    for (const file of readdirSync(join(blobDir, shard.name))) {
      count++
      const hash = SHA256.test(file)
        ? createHash("sha256")
            .update(readFileSync(join(blobDir, shard.name, file)))
            .digest("hex")
        : undefined
      if (hash !== file || file.slice(0, 2) !== shard.name) bad.push(file)
    }
  }
  return {
    name: "blobs",
    ok: bad.length === 0,
    detail:
      bad.length === 0
        ? `${count} blobs, each SHA-256 equals its name`
        : `${bad.length} of ${count} entries do not match their content hash`,
  }
}

/** Verifies a restored tree, found under `root` at the configured absolute paths. */
export function verifyRestored(config: BackupConfig, root: string): Check[] {
  const under = (path: string) => join(root, path)
  return [
    ...config.databases.flatMap((db) =>
      checkDatabase(under(db.staged), db.name)
    ),
    checkBlobs(under(config.blobDir)),
  ]
}

function assertEmptyTarget(target: string): void {
  if (existsSync(target) && readdirSync(target).length > 0)
    throw new BackupError(
      `${target} is not empty; restore into a new scratch directory`
    )
}

export type RestoreReport = {
  snapshot: string
  snapshotTime: Date
  seconds: number
  checks: Check[]
}

/** Restores `snapshot` (default: the newest) into `target` and verifies it. */
export async function runRestore(
  config: BackupConfig,
  deps: Deps,
  target: string,
  snapshot?: string
): Promise<RestoreReport> {
  assertEmptyTarget(target)
  const snapshots = await listSnapshots(config, deps)
  const chosen =
    snapshot === undefined
      ? snapshots.at(-1)
      : snapshots.find((s) => s.id.startsWith(snapshot))
  if (chosen === undefined)
    throw new BackupError(
      snapshot === undefined
        ? "the repository has no snapshots"
        : `no snapshot matches ${snapshot}`
    )
  const started = deps.now().getTime()
  await mustRun(
    deps.run,
    restoreArgs(chosen.id, target),
    resticEnv(config, deps.env)
  )
  const seconds = (deps.now().getTime() - started) / 1000
  return {
    snapshot: chosen.id,
    snapshotTime: chosen.time,
    seconds,
    checks: verifyRestored(config, target),
  }
}
