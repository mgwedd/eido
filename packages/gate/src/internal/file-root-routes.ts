import { validateGateFileRoots } from "@eido/schemas"
import type { GateFileRoots } from "@eido/schemas"
import { apiError } from "./http"
import type { GateRequest, Reply } from "./http"
import { prepareFileRoots, setFileRoots } from "./files/file-roots"
import type { FileHelper } from "./files/file-helper"
import type { WebAuthnConfig } from "./webauthn"

type FileRootRouteState = {
  db: Parameters<typeof prepareFileRoots>[0]
  fileHelper?: FileHelper
  webAuthn?: WebAuthnConfig
}

async function readJson(
  request: GateRequest
): Promise<{ ok: true; value: unknown } | { ok: false; reply: Reply }> {
  const body = await request.body()
  if (!body.ok)
    return {
      ok: false,
      reply: apiError(413, "invalid_request", "the body is over 1 MiB"),
    }
  try {
    const parsed: unknown = JSON.parse(body.text)
    return { ok: true, value: parsed }
  } catch {
    return {
      ok: false,
      reply: apiError(400, "invalid_request", "the body is not valid JSON"),
    }
  }
}

/**
 * Prepare: captures each requested root's canonical path and identity with the gate-side helper
 * and returns them with the challenge. The caller's paths are never echoed back.
 */
export async function prepareFileRootsRoute(
  request: GateRequest,
  state: FileRootRouteState
): Promise<Reply> {
  const parsed = await readJson(request)
  if (!parsed.ok) return parsed.reply
  if (state.fileHelper === undefined)
    return apiError(503, "unavailable", "the file helper is unavailable")
  try {
    const prepared = await prepareFileRoots(
      state.db,
      state.fileHelper,
      parsed.value
    )
    const payload: unknown = JSON.parse(prepared.payload)
    const checked = validateGateFileRoots(payload)
    if (!checked.ok) throw new Error("prepared roots are invalid")
    const roots: GateFileRoots = checked.value
    return {
      status: 200,
      body: {
        id: prepared.id,
        purpose: prepared.purpose,
        target: prepared.target,
        payloadHash: prepared.payloadHash,
        nonce: prepared.nonce,
        challenge: prepared.challenge,
        roots,
      },
    }
  } catch {
    return apiError(400, "invalid_request", "file roots could not be prepared")
  }
}

/** Complete: stores the roots only inside a verified, single-use `policy.set` passkey assertion. */
export async function completeFileRootsRoute(
  request: GateRequest,
  state: FileRootRouteState
): Promise<Reply> {
  const parsed = await readJson(request)
  if (!parsed.ok) return parsed.reply
  if (
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    !("roots" in parsed.value) ||
    !("authorization" in parsed.value)
  )
    return apiError(
      400,
      "invalid_request",
      "the request must contain roots and authorization"
    )
  const roots = validateGateFileRoots(parsed.value.roots)
  if (!roots.ok)
    return apiError(
      400,
      "invalid_request",
      "the request must contain valid file roots"
    )
  if (state.webAuthn === undefined)
    return apiError(503, "unavailable", "WebAuthn is unavailable")
  try {
    setFileRoots(state.db, roots.value, {
      config: state.webAuthn,
      request: parsed.value.authorization,
    })
    return { status: 200, body: { saved: true } }
  } catch {
    return apiError(
      409,
      "already_decided",
      "the file-roots approval was refused"
    )
  }
}

/**
 * The owner's file-root approval ceremony (#313) on the control listener. The phone listener
 * serves the same two handlers behind a session (#574).
 */
export async function fileRootRoute(
  request: GateRequest,
  state: FileRootRouteState
): Promise<Reply | undefined> {
  if (request.method !== "POST") return undefined
  if (request.path === "/file-roots/prepare")
    return prepareFileRootsRoute(request, state)
  if (request.path === "/file-roots/complete")
    return completeFileRootsRoute(request, state)
  return undefined
}
