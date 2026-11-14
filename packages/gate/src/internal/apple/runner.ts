import { spawn } from "node:child_process"
import { lstatSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import {
  validateGateAppleRequest,
  validateGateAppleResponse,
} from "@eido/schemas"
import type { GateAppleRequest, GateAppleResponse } from "@eido/schemas"

export const APPLE_MAX_BYTES = 1024 * 1024
export const APPLE_TIMEOUT_MS = 30_000
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

/** The only peer is the child inheriting these anonymous pipes; no listener is opened. */
export function createAppleRunner(
  path: string | undefined,
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {}
): AppleRunner {
  return async (request) => {
    if (
      (options.platform ?? process.platform) !== "darwin" ||
      path === undefined ||
      !isAbsolute(path)
    ) {
      throw new AppleError("unavailable")
    }
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
    } catch {
      throw new AppleError("unavailable")
    }
    return new Promise((resolve, reject) => {
      const child = (() => {
        try {
          return spawn(executable, [], {
            cwd: "/",
            env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
            stdio: ["pipe", "pipe", "ignore"],
          })
        } catch {
          throw new AppleError("unavailable")
        }
      })()
      let settled = false
      const chunks: Buffer[] = []
      let size = 0
      const finish = (error?: AppleError, result?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error !== undefined) {
          child.kill("SIGKILL")
          reject(error)
        } else resolve(result)
      }
      const timer = setTimeout(
        () => finish(new AppleError("unavailable")),
        options.timeoutMs ?? APPLE_TIMEOUT_MS
      )
      child.on("error", () => finish(new AppleError("unavailable")))
      child.stdin.on("error", () => finish(new AppleError("unavailable")))
      child.stdout.on("error", () => finish(new AppleError("unavailable")))
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > APPLE_MAX_BYTES) finish(new AppleError("unavailable"))
        else chunks.push(chunk)
      })
      child.on("close", (code) => {
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
