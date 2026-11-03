import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { GateBackupStatus } from "@eido/schemas"
import type { Clock } from "./sessions"

/** Freshness threshold matching the backup check command in infra (#30, #414). */
export const MAX_SNAPSHOT_AGE_HOURS = 36

/** Computes the default path where the nightly restic backup writes its last-success stamp. */
export function defaultBackupStampPath(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const fileOverride = env["EIDO_BACKUP_STAMP_FILE"]
  if (fileOverride !== undefined && fileOverride !== "") {
    return fileOverride
  }
  const logOverride = env["EIDO_BACKUP_LOG_DIR"]
  const logDir =
    logOverride === undefined || logOverride === ""
      ? join(homedir(), "Library", "Logs", "eido")
      : logOverride
  return join(logDir, "backup-last-success")
}

/**
 * Reads the last backup stamp and determines whether a backup has run,
 * and if so, whether the newest snapshot is fresh or stale (> 36 hours).
 */
export function readBackupStatus(
  stampPath: string | undefined,
  now: Clock = () => new Date()
): GateBackupStatus {
  if (stampPath === undefined || !existsSync(stampPath)) {
    return { status: "never_run", lastSuccess: null }
  }
  try {
    const raw = readFileSync(stampPath, "utf8").trim()
    if (!raw) {
      return { status: "never_run", lastSuccess: null }
    }
    const date = new Date(raw)
    if (Number.isNaN(date.getTime())) {
      return { status: "never_run", lastSuccess: null }
    }
    const ageMs = now().getTime() - date.getTime()
    const ageHours = ageMs / 3_600_000
    const isStale = ageHours > MAX_SNAPSHOT_AGE_HOURS
    return {
      status: isStale ? "stale" : "fresh",
      lastSuccess: date.toISOString(),
    }
  } catch {
    return { status: "never_run", lastSuccess: null }
  }
}
