// Builds the gate's confined file helper, installs it into a directory only the gate's user can
// write, and prints the pin for the gate configuration (ADR 0006, "Provenance"; #463).
// Usage: node scripts/install-file-helper.ts <absolute install directory>
// Re-run it after every upgrade: the printed pin changes and the gate refuses the old one.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs"
import path from "node:path"

export type FileHelperInstall = { path: string; sha256: string }

const BINARY = "eido-file-helper"

/** The binary name for a platform; Windows adds `.exe`. */
export function helperFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? `${BINARY}.exe` : BINARY
}

/**
 * Copies `source` into `installDir` and returns its location and SHA-256. Refuses a relative
 * directory, and on POSIX a directory that group or others can write, since the pin only covers
 * the file at rest (ADR 0006). On Windows the directory must get a gate/admin-only ACL instead.
 */
export function installFileHelper(
  source: string,
  installDir: string,
  platform: NodeJS.Platform = process.platform
): FileHelperInstall {
  if (!path.isAbsolute(installDir))
    throw new Error("the install directory must be an absolute path")
  mkdirSync(installDir, { recursive: true, mode: 0o700 })
  if (platform !== "win32" && (statSync(installDir).mode & 0o022) !== 0)
    throw new Error(
      "the install directory is writable by group or others; fix its mode first"
    )
  const target = path.join(installDir, helperFileName(platform))
  // Copy beside the target and rename, so the gate never sees a half-written binary.
  const staged = `${target}.new`
  copyFileSync(source, staged)
  if (platform !== "win32") chmodSync(staged, 0o700)
  renameSync(staged, target)
  const sha256 = createHash("sha256").update(readFileSync(target)).digest("hex")
  return { path: target, sha256 }
}

/** The environment lines the gate reads (see docs/local-files.md). */
export function pinLines(install: FileHelperInstall): string {
  return `EIDO_FILE_HELPER_PATH=${install.path}\nEIDO_FILE_HELPER_SHA256=${install.sha256}`
}

function main(): void {
  const installDir = process.argv[2]
  if (installDir === undefined || process.argv.length !== 3)
    throw new Error(
      "usage: install-file-helper.ts <absolute install directory>"
    )
  const root = path.resolve(import.meta.dirname, "..")
  const crate = path.join(root, "packages/gate/native/file-helper")
  const build = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      path.join(crate, "Cargo.toml"),
    ],
    { stdio: "inherit" }
  )
  if (build.status !== 0) throw new Error("cargo build failed")
  const built = path.join(
    crate,
    "target/release",
    helperFileName(process.platform)
  )
  console.log(pinLines(installFileHelper(built, installDir)))
}

if (import.meta.main) main()
