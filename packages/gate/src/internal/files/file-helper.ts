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
import {
  BRIDGE_MAX_RESPONSE_BYTES,
  SessionBridgeRefusal,
  SessionUnavailableError,
  bridgeStdout,
  bridgeTimeout,
} from "../session-bridge/client"
import type { SessionBridge } from "../session-bridge/client"

/** The installed helper binary and the SHA-256 it must have (ADR 0006). */
export type FileHelperConfig = { path: string; sha256: string }
export type FileHelper = (
  request: GateFileHelperRequest
) => Promise<GateFileHelperResponse>

const MAX_REPLY_BYTES = 64 * 1024
const TIMEOUT_MS = 30_000
/** The bridge's 30 s helper limit plus its receive and reply limits (worst case 50 s), with margin. */
export const BRIDGE_TIMEOUT_MS = bridgeTimeout(TIMEOUT_MS)
const failed = (cause?: unknown) =>
  new Error("file helper failed", cause === undefined ? undefined : { cause })

/**
 * The session bridge refused the request's folder: it is not on the host's approved file roots
 * list, or the directory there is no longer the one listed. Nothing ran.
 */
export class HostRootNotApproved extends Error {
  constructor() {
    super("the host has not approved this folder")
    this.name = "HostRootNotApproved"
  }
}

/** The helper's stdout, one JSON line, schema-checked and never cast. */
function parseReply(stdout: Buffer): GateFileHelperResponse {
  let raw: unknown
  try {
    raw = JSON.parse(stdout.toString("utf8"))
  } catch {
    throw failed()
  }
  const checked = validateGateFileHelperResponse(raw)
  if (!checked.ok) throw failed()
  return checked.value
}

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

function run(
  path: string,
  input: string,
  limit: number
): Promise<GateFileHelperResponse> {
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
      size += Buffer.isBuffer(chunk) ? chunk.length : limit + 1
      if (!Buffer.isBuffer(chunk) || size > limit) {
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
        resolve(parseReply(Buffer.concat(chunks)))
      } catch {
        fail()
      }
    })
    child.stdin.end(input)
  })
}

/**
 * The same request run by the bridge in the owner's session (#826). The bridge checks the
 * helper's pin again and applies the same stdout limits; the gate checks the limit and the
 * schema once more on what comes back.
 */
async function viaBridge(
  bridge: SessionBridge,
  request: GateFileHelperRequest,
  limit: number
): Promise<GateFileHelperResponse> {
  let stdout: Buffer
  try {
    stdout = await bridgeStdout(
      bridge,
      { op: "file", request },
      {
        timeoutMs: BRIDGE_TIMEOUT_MS,
        maxResponseBytes: BRIDGE_MAX_RESPONSE_BYTES,
      }
    )
  } catch (error) {
    if (error instanceof SessionUnavailableError) throw error
    if (
      error instanceof SessionBridgeRefusal &&
      error.code === "root_not_approved"
    )
      throw new HostRootNotApproved()
    // Keeps a sent request's unknown outcome visible to the executor (#893).
    throw failed(error)
  }
  if (stdout.length > limit) throw failed()
  return parseReply(stdout)
}

/**
 * Runs one request per helper process; the reply is schema-checked, never cast. With `bridge`
 * the helper runs in the owner's session, after the same pin check here.
 */
export function fileHelper(
  config: FileHelperConfig,
  bridge?: SessionBridge
): FileHelper {
  return async (request) => {
    const checked = validateGateFileHelperRequest(request)
    if (!checked.ok) throw failed()
    await checkPin(config)
    const limit =
      checked.value.op === "read"
        ? 12 * 1024 * 1024
        : checked.value.op === "list"
          ? 512 * 1024
          : MAX_REPLY_BYTES
    if (bridge !== undefined) return viaBridge(bridge, checked.value, limit)
    return run(config.path, JSON.stringify(checked.value), limit)
  }
}
