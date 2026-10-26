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
const WORK_MARKER_CONTENT = "eido-parser-scratch-v1"

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
      readFileSync(join(path, WORK_MARKER), "utf8") !== WORK_MARKER_CONTENT ||
      now - info.mtimeMs < STALE_AFTER_MS
    ) {
      continue
    }
    rmSync(path, { recursive: true, force: true })
  }
}

/** Creates an identifiable generated work directory so cleanup can prove ownership. */
export function createPrivateWorkDirectory(root: string): string {
  const workDir = mkdtempSync(join(root, "parse-"))
  writeFileSync(join(workDir, WORK_MARKER), WORK_MARKER_CONTENT, {
    flag: "wx",
    mode: 0o600,
  })
  return workDir
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
