import { spawnSync } from "node:child_process"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const BACKUP_EXCLUSION = "com.apple.metadata:com_apple_backup_excludeItem"
const WORK_MARKER = ".eido-parser-work"

type WorkOwners = { parentPid: number | null; childPid: number | null }

function markerOwners(path: string): number[] | null {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const version: unknown = Reflect.get(value, "version")
  const parentPid: unknown = Reflect.get(value, "parentPid")
  const childPid: unknown = Reflect.get(value, "childPid")
  if (version !== 1 || !isNullablePid(parentPid) || !isNullablePid(childPid)) {
    return null
  }
  return [parentPid, childPid].filter((pid): pid is number => pid !== null)
}

function isNullablePid(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) > 0)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false
    }
    // Permission and unexpected errors are treated as alive to avoid deleting active work.
    return true
  }
}

function excludeFromMacBackups(root: string): void {
  const set = spawnSync(
    "/usr/bin/xattr",
    ["-w", BACKUP_EXCLUSION, "com.apple.backupd", root],
    {
      encoding: "utf8",
    }
  )
  if (set.error !== undefined || set.status !== 0) {
    throw new Error("could not exclude parser scratch from system backups")
  }
  const verify = spawnSync("/usr/bin/xattr", ["-p", BACKUP_EXCLUSION, root], {
    encoding: "utf8",
  })
  if (
    verify.error !== undefined ||
    verify.status !== 0 ||
    verify.stdout.trim() !== "com.apple.backupd"
  ) {
    throw new Error("parser scratch backup exclusion could not be verified")
  }
}

function sweepStaleWork(root: string, now: number): void {
  for (const name of readdirSync(root)) {
    if (!/^parse-[A-Za-z0-9_-]+$/.test(name)) continue
    const path = join(root, name)
    let info
    let marker
    try {
      info = lstatSync(path)
      marker = lstatSync(join(path, WORK_MARKER))
    } catch {
      continue
    }
    if (
      !info.isDirectory() ||
      !marker.isFile() ||
      marker.isSymbolicLink() ||
      (marker.mode & 0o077) !== 0 ||
      now - info.mtimeMs < STALE_AFTER_MS
    ) {
      continue
    }
    const owners = markerOwners(join(path, WORK_MARKER))
    if (owners === null || owners.some(processIsAlive)) continue
    rmSync(path, { recursive: true, force: true })
  }
}

/** Creates an identifiable generated work directory so cleanup can prove ownership. */
export function createPrivateWorkDirectory(
  root: string,
  owners: WorkOwners = { parentPid: process.pid, childPid: null }
): string {
  const workDir = mkdtempSync(join(root, "parse-"))
  writeFileSync(
    join(workDir, WORK_MARKER),
    JSON.stringify({ version: 1, ...owners }),
    {
      flag: "wx",
      mode: 0o600,
    }
  )
  return workDir
}

/** Records the parse child too, so cleanup can preserve it if its parent exits unexpectedly. */
export function recordPrivateWorkChild(
  workDir: string,
  childPid: number
): void {
  writeFileSync(
    join(workDir, WORK_MARKER),
    JSON.stringify({ version: 1, parentPid: process.pid, childPid }),
    { mode: 0o600 }
  )
}

/** Creates and hardens the parser-only scratch root, then reaps abandoned generated work. */
export function preparePrivateScratchRoot(
  root: string,
  platform: NodeJS.Platform = process.platform,
  now: number = Date.now()
): void {
  if (platform === "win32") {
    throw new Error("private parser scratch is unsupported on this platform")
  }
  let existed = false
  try {
    const info = lstatSync(root)
    existed = true
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("parser scratch root is not a private directory")
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error("parser scratch root has group or world access")
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // Created below with restrictive permissions.
    } else {
      throw error
    }
  }
  if (!existed) mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  const info = lstatSync(root)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("parser scratch root is not private")
  }
  if (platform === "darwin") excludeFromMacBackups(root)
  sweepStaleWork(root, now)
}
