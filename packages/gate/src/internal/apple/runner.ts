import { spawn } from "node:child_process"
import { lstatSync } from "node:fs"
import { isAbsolute } from "node:path"
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
    try {
      const file = lstatSync(path)
      if (
        !file.isFile() ||
        (file.mode & 0o022) !== 0 ||
        (file.mode & 0o111) === 0 ||
        (process.getuid !== undefined && file.uid !== process.getuid())
      ) {
        throw new AppleError("unavailable")
      }
    } catch {
      throw new AppleError("unavailable")
    }
    return new Promise((resolve, reject) => {
      const child = spawn(path, [], {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        stdio: ["pipe", "pipe", "ignore"],
      })
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
