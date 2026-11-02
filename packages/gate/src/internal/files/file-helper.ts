import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  validateGateFileHelperRequest,
  validateGateFileHelperResponse,
} from "@eido/schemas"
import type {
  GateFileHelperRequest,
  GateFileHelperResponse,
} from "@eido/schemas"

/** The installed helper binary and the SHA-256 it must have (ADR 0006). */
export type FileHelperConfig = { path: string; sha256: string }
export type FileHelper = (
  request: GateFileHelperRequest
) => Promise<GateFileHelperResponse>

const MAX_REPLY_BYTES = 64 * 1024
const TIMEOUT_MS = 30_000
const failed = () => new Error("file helper failed")

/** Refuses a binary whose bytes differ from the pinned hash, before anything runs. */
async function checkPin(config: FileHelperConfig): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(config.sha256)) throw failed()
  let bytes: Buffer
  try {
    bytes = await readFile(config.path)
  } catch {
    throw failed()
  }
  if (createHash("sha256").update(bytes).digest("hex") !== config.sha256)
    throw new Error("file helper does not match its pinned hash")
}

function run(path: string, input: string): Promise<GateFileHelperResponse> {
  return new Promise((resolve, reject) => {
    // No shell, no arguments, no inherited environment: the request travels on stdin only.
    const child = spawn(path, [], {
      stdio: "pipe",
      timeout: TIMEOUT_MS,
      env: {},
      shell: false,
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    const fail = () => reject(failed())
    child.on("error", fail)
    child.stdin.on("error", fail)
    // The helper writes nothing to stderr by design; never forward it if a runtime does.
    child.stderr.resume()
    child.stdout.on("data", (chunk: unknown) => {
      size += Buffer.isBuffer(chunk) ? chunk.length : MAX_REPLY_BYTES + 1
      if (!Buffer.isBuffer(chunk) || size > MAX_REPLY_BYTES) {
        overflow = true
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.on("close", (code) => {
      if (code !== 0 || overflow) {
        fail()
        return
      }
      try {
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        const checked = validateGateFileHelperResponse(raw)
        if (checked.ok) resolve(checked.value)
        else fail()
      } catch {
        fail()
      }
    })
    child.stdin.end(input)
  })
}

/** Runs one request per helper process; the reply is schema-checked, never cast. */
export function fileHelper(config: FileHelperConfig): FileHelper {
  return async (request) => {
    const checked = validateGateFileHelperRequest(request)
    if (!checked.ok) throw failed()
    await checkPin(config)
    return run(config.path, JSON.stringify(checked.value))
  }
}
