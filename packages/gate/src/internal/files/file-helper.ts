import { spawn } from "node:child_process"
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
import type { FileHelperCopy } from "./file-helper-copy"

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

/**
 * The private copy's path once it is still the file made at start with the pinned bytes
 * (#903). A changed, swapped or removed copy is refused before anything runs.
 */
async function verifiedCopy(copy: FileHelperCopy): Promise<string> {
  const path = await copy.verified()
  if (path === undefined) throw failed()
  return path
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
 * Runs one request per helper process, from the gate's private copy of the pinned helper
 * (`installFileHelperCopy`), never from the configured path; the reply is schema-checked, never
 * cast. With `bridge` the helper runs in the owner's session, after the same copy check here and
 * a check that the configured path, which the bridge runs, still has the pinned bytes.
 */
export function fileHelper(
  copy: FileHelperCopy,
  bridge?: SessionBridge
): FileHelper {
  return async (request) => {
    const checked = validateGateFileHelperRequest(request)
    if (!checked.ok) throw failed()
    const path = await verifiedCopy(copy)
    const limit =
      checked.value.op === "read"
        ? 12 * 1024 * 1024
        : checked.value.op === "list"
          ? 512 * 1024
          : MAX_REPLY_BYTES
    if (bridge !== undefined) {
      // The bridge runs the configured path, so its bytes are checked on every request as well.
      if (!(await copy.sourceMatches()))
        throw new Error("file helper does not match its pinned hash")
      return viaBridge(bridge, checked.value, limit)
    }
    return run(path, JSON.stringify(checked.value), limit)
  }
}
