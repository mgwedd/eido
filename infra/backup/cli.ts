// `backup run|check|restore <dir> [--snapshot <id>]|verify <dir>|plist` (#30)
//   run      consistent copies of both databases plus the blob store into a restic snapshot,
//            then retention; writes the last-success stamp
//   check    exits non-zero when the newest snapshot is over 36 hours old, or the drive is absent
//   restore  restores a snapshot into a new scratch directory and verifies it
//   verify   verifies an already-restored directory
//   plist    prints the nightly LaunchAgent plist; installing it is a manual step
import { resolve } from "node:path"

import { runBackup, runCheck, type Deps } from "./backup.ts"
import { buildBackupConfig } from "./config.ts"
import { renderPlist } from "./plist.ts"
import { runRestore, verifyRestored, type Check } from "./restore.ts"
import { BackupError } from "./errors.ts"

export type Io = {
  /** Writes one line to standard output. */
  out: (line: string) => void
  /** Writes one line to standard error. */
  err: (line: string) => void
}

export type Context = Deps & {
  home: string
  repoRoot: string
  nodePath: string
  binPath: string
  io: Io
}

const USAGE =
  "usage: backup run | check | restore <dir> [--snapshot <id>] | verify <dir> | plist"

function printChecks(checks: readonly Check[], io: Io): boolean {
  for (const c of checks)
    io.out(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`)
  return checks.every((c) => c.ok)
}

/** Parses `<dir> [--snapshot <id>]`. */
function restoreOptions(rest: readonly string[]) {
  const dir = rest[0]
  if (dir === undefined || dir.startsWith("--")) return undefined
  const flag = rest[1]
  if (flag === undefined) return { dir: resolve(dir) }
  const id = rest[2]
  if (flag !== "--snapshot" || id === undefined || rest.length > 3)
    return undefined
  return { dir: resolve(dir), snapshot: id }
}

export async function main(
  argv: readonly string[],
  ctx: Context
): Promise<number> {
  const [command, ...rest] = argv
  const { io } = ctx
  try {
    const config = buildBackupConfig({
      env: ctx.env,
      home: ctx.home,
      repoRoot: ctx.repoRoot,
    })
    switch (command) {
      case "run": {
        await runBackup(config, ctx)
        return 0
      }
      case "check": {
        const { id, ageHours } = await runCheck(config, ctx)
        io.out(`ok: newest snapshot ${id} is ${Math.floor(ageHours)} hours old`)
        return 0
      }
      case "restore": {
        const options = restoreOptions(rest)
        if (options === undefined) {
          io.err(USAGE)
          return 2
        }
        const report = await runRestore(
          config,
          ctx,
          options.dir,
          options.snapshot
        )
        io.out(
          `snapshot ${report.snapshot} (${report.snapshotTime.toISOString()}) restored to ${options.dir} in ${report.seconds.toFixed(1)}s`
        )
        return printChecks(report.checks, io) ? 0 : 1
      }
      case "verify": {
        const dir = rest[0]
        if (dir === undefined || rest.length > 1) {
          io.err(USAGE)
          return 2
        }
        return printChecks(verifyRestored(config, resolve(dir)), io) ? 0 : 1
      }
      case "plist": {
        io.out(
          renderPlist({
            config,
            env: ctx.env,
            home: ctx.home,
            nodePath: ctx.nodePath,
            binPath: ctx.binPath,
          }).trimEnd()
        )
        return 0
      }
      default:
        io.err(USAGE)
        return 2
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.log(`ERROR ${command ?? ""}: ${message}`)
    if (!(error instanceof BackupError)) io.err(String(error))
    return 1
  }
}
