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

/** Handles the owner's file-root approval ceremony on the control listener only. */
export async function fileRootControlRoute(
  request: GateRequest,
  state: FileRootRouteState
): Promise<Reply | undefined> {
  if (request.method === "POST" && request.path === "/file-roots/prepare") {
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

  if (request.method === "POST" && request.path === "/file-roots/complete") {
    const parsed = await readJson(request)
    if (!parsed.ok) return parsed.reply
    if (
      typeof parsed.value !== "object" ||
      parsed.value === null ||
      !("roots" in parsed.value) ||
      !("authorization" in parsed.value)
    )
      return apiError(400, "invalid_request", "the request must contain roots and authorization")
    const roots = validateGateFileRoots(parsed.value.roots)
    if (!roots.ok)
      return apiError(400, "invalid_request", "the request must contain valid file roots")
    if (state.webAuthn === undefined)
      return apiError(503, "unavailable", "WebAuthn is unavailable")
    try {
      setFileRoots(state.db, roots.value, {
        config: state.webAuthn,
        request: parsed.value.authorization,
      })
      return { status: 200, body: { saved: true } }
    } catch {
      return apiError(409, "already_decided", "the file-roots approval was refused")
    }
  }
  return undefined
}
