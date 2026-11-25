import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import {
  validateGateAppleRequest,
  validateGateAppleResponse,
} from "@eido/schemas"
import type { GateAppleRequest, GateAppleResponse } from "@eido/schemas"

export const APPLE_MAX_BYTES = 1024 * 1024
export const APPLE_TIMEOUT_MS = 30_000
/** Helper processes one runner keeps alive at once; a call beyond it is refused, not queued. */
export const APPLE_MAX_CONCURRENT = 4
/** The installed Helper binary and the SHA-256 it must have, like the file helper (ADR 0006). */
export type AppleHelperConfig = { path: string; sha256: string }
export type AppleErrorCode = Extract<GateAppleResponse, { ok: false }>["code"]
export class AppleError extends Error {
  readonly code: AppleErrorCode
  constructor(code: AppleErrorCode) {
    super(`Apple Helper refused: ${code}`)
    this.name = "AppleError"
    this.code = code
  }
}
export type AppleRunner = (request: GateAppleRequest) => Promise<unknown>

function trustedParents(
  path: string,
  uid: number,
  followAliases: boolean
): void {
  let parent = dirname(path)
  for (;;) {
    const entry = lstatSync(parent)
    // Sticky directories protect an alias only from other owners. An alias owned
    // by an untrusted principal can still redirect a trusted configured path.
    if (entry.isSymbolicLink() && entry.uid !== uid && entry.uid !== 0) {
      throw new AppleError("unavailable")
    }
    const directory = followAliases ? statSync(parent) : entry
    if (
      !directory.isDirectory() ||
      (directory.uid !== uid && directory.uid !== 0) ||
      // A gate/root-owned sticky directory (for example /private/tmp) protects its
      // gate/root-owned children from replacement by another OS principal.
      ((directory.mode & 0o022) !== 0 && (directory.mode & 0o1000) === 0)
    ) {
      throw new AppleError("unavailable")
    }
    const ancestor = dirname(parent)
    if (ancestor === parent) break
    parent = ancestor
  }
}

/** Kills the Helper's process group, so nothing it started outlives it, then the Helper. */
function killGroup(child: ChildProcess): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      // The group is already gone.
    }
  }
  child.kill("SIGKILL")
}

/** The only peer is the child inheriting these anonymous pipes; no listener is opened. */
export function createAppleRunner(
  helper: AppleHelperConfig | undefined,
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {}
): AppleRunner {
  let running = 0
  return async (request) => {
    if (
      (options.platform ?? process.platform) !== "darwin" ||
      helper === undefined ||
      !isAbsolute(helper.path) ||
      !/^[0-9a-f]{64}$/.test(helper.sha256)
    ) {
      throw new AppleError("unavailable")
    }
    const { path } = helper
    const checked = validateGateAppleRequest(request)
    if (!checked.ok) throw new AppleError("invalid_request")
    const input = JSON.stringify(checked.value)
    if (Buffer.byteLength(input) > APPLE_MAX_BYTES)
      throw new AppleError("invalid_request")
    let executable: string
    try {
      const uid = process.getuid?.()
      if (uid === undefined || !lstatSync(path).isFile()) {
        throw new AppleError("unavailable")
      }
      // Resolve directory aliases once and launch only this canonical path. Checking the
      // final inode alone leaves an attacker-writable ancestor free to replace it before spawn.
      executable = realpathSync(path)
      const file = lstatSync(executable)
      if (
        !file.isFile() ||
        file.uid !== uid ||
        (file.mode & 0o022) !== 0 ||
        (file.mode & 0o111) === 0
      ) {
        throw new AppleError("unavailable")
      }
      // Check the alias location too: an unsafe directory must not choose which
      // otherwise trusted binary this gate configuration resolves to.
      trustedParents(path, uid, true)
      trustedParents(executable, uid, false)
      // Hash the bytes that will run: a rebuilt or swapped binary is refused before spawn.
      const digest = createHash("sha256")
        .update(readFileSync(executable))
        .digest("hex")
      if (digest !== helper.sha256) throw new AppleError("unavailable")
    } catch {
      throw new AppleError("unavailable")
    }
    if (running >= APPLE_MAX_CONCURRENT) throw new AppleError("unavailable")
    return new Promise((resolve, reject) => {
      const child = (() => {
        try {
          // detached makes the Helper a process group leader, so a timeout kills its children too.
          return spawn(executable, [], {
            cwd: "/",
            detached: true,
            env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
            stdio: ["pipe", "pipe", "ignore"],
          })
        } catch {
          throw new AppleError("unavailable")
        }
      })()
      // Held until the process is gone, not just until the call settles.
      running += 1
      let released = false
      const release = () => {
        if (released) return
        released = true
        running -= 1
      }
      child.on("exit", release)
      let settled = false
      const chunks: Buffer[] = []
      let size = 0
      const finish = (error?: AppleError, result?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error !== undefined) {
          killGroup(child)
          reject(error)
        } else resolve(result)
      }
      const timer = setTimeout(
        () => finish(new AppleError("unavailable")),
        options.timeoutMs ?? APPLE_TIMEOUT_MS
      )
      child.on("error", () => {
        if (child.pid === undefined) release()
        finish(new AppleError("unavailable"))
      })
      child.stdin.on("error", () => finish(new AppleError("unavailable")))
      child.stdout.on("error", () => finish(new AppleError("unavailable")))
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > APPLE_MAX_BYTES) finish(new AppleError("unavailable"))
        else chunks.push(chunk)
      })
      child.on("close", (code) => {
        release()
        if (settled) return
        if (code !== 0) return finish(new AppleError("unavailable"))
        try {
          const parsed: unknown = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          )
          const response = validateGateAppleResponse(parsed)
          if (!response.ok) return finish(new AppleError("unavailable"))
          if (!response.value.ok)
            return finish(new AppleError(response.value.code))
          finish(undefined, response.value.result)
        } catch {
          finish(new AppleError("unavailable"))
        }
      })
      child.stdin.end(input)
    })
  }
}
