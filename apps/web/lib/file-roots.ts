import {
  validateGateApiError,
  validateGateFileRootsPrepared,
  validateGateFileRootsSaved,
  type GateApiError,
  type GateFileRoot,
  type GateFileRoots,
  type GateFileRootsCompletion,
  type GateFileRootsPrepared,
  type GateFileRootsRequest,
} from "@eido/schemas"
import { canonicalize, sha256 } from "@/lib/approval/canonical"
import { toBase64url } from "@/lib/approval/challenge"
import { toAssertion } from "@/lib/approval/sign"

export const FILE_ROOTS_PREPARE_URL = "/api/gate/file-roots/prepare"
export const FILE_ROOTS_COMPLETE_URL = "/api/gate/file-roots/complete"

/** The passkey prompt, injectable so tests need no browser. */
export type FileRootsDevice = {
  getCredential(options: CredentialRequestOptions): Promise<Credential | null>
  rpId: string
}

export function browserFileRootsDevice(): FileRootsDevice {
  return {
    getCredential: (options) => navigator.credentials.get(options),
    rpId: window.location.hostname,
  }
}

/** One folder on the review page: the path that was asked for and the root the host found. */
export type ReviewFolder = { id: string; requested: string; root: GateFileRoot }

/** A prepared list that checked out on this device, ready to sign. */
export type PreparedFolders = {
  prepared: GateFileRootsPrepared
  folders: readonly ReviewFolder[]
  challenge: Uint8Array<ArrayBuffer>
}

/** A failed step: a session that expired (401), or what to show. */
export type FileRootsFailure =
  | { ok: false; expired: true }
  | { ok: false; expired?: undefined; unreachable: boolean; message: string }

export type PrepareOutcome =
  { ok: true; value: PreparedFolders } | FileRootsFailure

export type SignOutcome =
  | { ok: true }
  | { ok: false; expired?: undefined; cancelled: true }
  | FileRootsFailure

export const FILE_ROOTS_MESSAGES = {
  unreachable: "Can't reach the gate on the host. Nothing was changed.",
  unreadable: "The gate sent an unreadable answer. Nothing was changed.",
  unidentified: "The host couldn't identify every folder. Nothing was changed.",
  noHelper: "The file helper isn't running on the host. Nothing was changed.",
  mismatch:
    "The list the gate prepared does not match the folders asked for. Nothing was signed.",
  refused: "The gate refused the signature. The allowed folders are unchanged.",
  cannotCheck:
    "The gate can't check the signature or the folders right now. Nothing was changed.",
  changed: "A folder changed on the host since you reviewed it. Review again.",
} as const

/** The folder the host could not identify, named by the id it was asked for under. */
export const folderMissingMessage = (id: string) =>
  `${id} doesn't exist on the host. Remove it or fix the path.`

const fail = (message: string, unreachable = false): FileRootsFailure => ({
  ok: false,
  unreachable,
  message,
})

/** The request that asks the host to identify the folders of a signed list again. */
export function requestFromSigned(signed: GateFileRoots): GateFileRootsRequest {
  return {
    roots: signed.roots.map(({ id, root }) => ({
      id,
      path: root.path,
      trashDir: root.trashDir,
    })),
  }
}

/** The host's canonical path differs from the one asked for: a link or alias was followed. */
export function resolvedThroughLink(folder: ReviewFolder): boolean {
  return folder.requested !== folder.root.path
}

/** "dev:ino", the identity the helper checks before every operation. */
export function identity(root: GateFileRoot): string {
  return `${root.dev}:${root.ino}`
}

/** The trash directory as a full path under the root, with the root's own separator. */
export function trashPath(root: GateFileRoot): string {
  const separator = root.path.startsWith("/") ? "/" : "\\"
  return root.path.endsWith(separator)
    ? `${root.path}${root.trashDir}`
    : `${root.path}${separator}${root.trashDir}`
}

/** "b7e2 19c4 55af 0d31": the first eight challenge bytes in hex, grouped by four. */
export function challengeCode(challenge: Uint8Array): string {
  const hex = Array.from(challenge.slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return hex.replace(/(.{4})(?=.)/g, "$1 ")
}

async function post(
  url: string,
  body: unknown,
  errorFor: (error: GateApiError, status: number) => string,
  signal?: AbortSignal
): Promise<
  { ok: true; json: unknown } | { ok: false; outcome: FileRootsFailure }
> {
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    return { ok: false, outcome: fail(FILE_ROOTS_MESSAGES.unreachable, true) }
  }
  if (response.status === 401)
    return { ok: false, outcome: { ok: false, expired: true } }
  if (!response.ok) {
    const json: unknown = await response.json().catch(() => undefined)
    const error = validateGateApiError(json)
    if (error.ok)
      return {
        ok: false,
        outcome: fail(errorFor(error.value, response.status)),
      }
    // Tailscale serve answers 502 or 504 itself when the gate on the host is down.
    const gateDown = response.status === 502 || response.status === 504
    return {
      ok: false,
      outcome: gateDown
        ? fail(FILE_ROOTS_MESSAGES.unreachable, true)
        : fail(FILE_ROOTS_MESSAGES.unreadable),
    }
  }
  try {
    const json: unknown = await response.json()
    return { ok: true, json }
  } catch {
    return { ok: false, outcome: fail(FILE_ROOTS_MESSAGES.unreadable) }
  }
}

/**
 * Recomputes on this device what the gate should have prepared for `request` and returns the
 * folders and challenge to sign, or undefined when the card binds anything else: the ids and
 * trash names must be the requested ones in order, the payload hash must be the RFC 8785 hash
 * of the returned roots, and the challenge the control-ceremony hash over those values.
 */
export async function checkedFileRoots(
  request: GateFileRootsRequest,
  prepared: GateFileRootsPrepared
): Promise<PreparedFolders | undefined> {
  const returned = prepared.roots.roots
  if (returned.length !== request.roots.length) return undefined
  const folders: ReviewFolder[] = []
  for (const [index, asked] of request.roots.entries()) {
    const got = returned[index]
    if (
      got === undefined ||
      got.id !== asked.id ||
      got.root.trashDir !== asked.trashDir
    )
      return undefined
    folders.push({ id: got.id, requested: asked.path, root: got.root })
  }
  const payloadHash = await sha256(canonicalize(prepared.roots))
  const challenge = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      canonicalize([
        "eido.control.v1",
        "policy.set",
        "file-roots",
        prepared.id,
        payloadHash,
        prepared.nonce,
      ])
    )
  )
  if (
    payloadHash !== prepared.payloadHash ||
    toBase64url(challenge) !== prepared.challenge
  )
    return undefined
  return { prepared, folders, challenge }
}

/** Asks the host to identify each requested folder and checks the list it prepared. */
export async function prepareFileRoots(
  request: GateFileRootsRequest,
  signal?: AbortSignal
): Promise<PrepareOutcome> {
  const prepare = await post(
    FILE_ROOTS_PREPARE_URL,
    request,
    (error, status) =>
      error.code === "root_missing"
        ? folderMissingMessage(error.rootId)
        : status === 503
          ? FILE_ROOTS_MESSAGES.noHelper
          : FILE_ROOTS_MESSAGES.unidentified,
    signal
  )
  if (!prepare.ok) return prepare.outcome
  const prepared = validateGateFileRootsPrepared(prepare.json)
  if (!prepared.ok) return fail(FILE_ROOTS_MESSAGES.unreadable)
  const checked = await checkedFileRoots(request, prepared.value)
  return checked === undefined
    ? fail(FILE_ROOTS_MESSAGES.mismatch)
    : { ok: true, value: checked }
}

/**
 * Signs the checked list with the device passkey and asks the gate to store it. The gate
 * replaces the allowed list only when the signature verifies over exactly these roots.
 * `signal` cancels the passkey prompt only, so a sent request always gets its true answer.
 */
export async function signFileRoots(
  folders: PreparedFolders,
  device: FileRootsDevice,
  signal?: AbortSignal
): Promise<SignOutcome> {
  let credential: Credential | null
  try {
    credential = await device.getCredential({
      publicKey: {
        challenge: folders.challenge.buffer,
        rpId: device.rpId,
        userVerification: "required",
        timeout: 60_000,
      },
      signal,
    })
  } catch {
    return { ok: false, cancelled: true }
  }
  const assertion =
    credential instanceof PublicKeyCredential
      ? toAssertion(credential)
      : undefined
  // Cancel after the prompt returned still wins; once the request is sent it is not withdrawn.
  if (assertion === undefined || signal?.aborted === true)
    return { ok: false, cancelled: true }

  const completion: GateFileRootsCompletion = {
    roots: folders.prepared.roots,
    authorization: {
      id: folders.prepared.id,
      nonce: folders.prepared.nonce,
      assertion,
    },
  }
  const complete = await post(
    FILE_ROOTS_COMPLETE_URL,
    completion,
<<<<<<< HEAD
    (error, status) =>
      error.code === "root_changed"
        ? FILE_ROOTS_MESSAGES.changed
        : status === 503
          ? FILE_ROOTS_MESSAGES.cannotCheck
          : FILE_ROOTS_MESSAGES.refused
=======
    (_, status) =>
      status === 503
        ? FILE_ROOTS_MESSAGES.noWebAuthn
        : FILE_ROOTS_MESSAGES.refused
>>>>>>> 4ac5abe47baa27f6272122798bcb62a379968c9f
  )
  if (!complete.ok) return complete.outcome
  return validateGateFileRootsSaved(complete.json).ok
    ? { ok: true }
    : fail(FILE_ROOTS_MESSAGES.unreadable)
}
