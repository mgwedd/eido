import { asObject } from "./json"

// Typed failures of the Gmail connector. Health (#24) counts them by `code`; nothing here retries.

export type GmailErrorCode =
  | "grant_revoked"
  | "history_expired"
  | "not_found"
  | "no_recipients"
  | "gate_unavailable"
  | "upstream_error"
  | "invalid_response"

export class GmailError extends Error {
  override readonly name = "GmailError"
  readonly code: GmailErrorCode
  /** HTTP status of the response that caused it, when there was one. */
  readonly status: number | undefined
  // Plain fields, not parameter properties: Node runs this file with type stripping only.
  constructor(code: GmailErrorCode, message: string, status?: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

const field = (value: unknown, key: string): unknown => asObject(value)?.[key]

/** True when a response body names a revoked or expired OAuth grant. */
function namesRevokedGrant(body: unknown): boolean {
  // The gate's egress proxy answers `{ reason: "grant_revoked" }` after it saw a 401 upstream;
  // Google's token endpoint answers `{ error: "invalid_grant" }`.
  return (
    field(body, "reason") === "grant_revoked" ||
    field(body, "error") === "invalid_grant"
  )
}

/**
 * Maps a failed response onto a typed error. A 401, or any body naming a revoked grant, is
 * `grant_revoked`: the caller stops and does not retry (the gate's vault handles the revocation).
 */
export async function errorFromResponse(
  response: Response
): Promise<GmailError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (response.status === 401 || namesRevokedGrant(body))
    return new GmailError(
      "grant_revoked",
      "the Gmail grant was revoked; reconnect the account",
      response.status
    )
  if (response.status === 404)
    return new GmailError("not_found", "Gmail has no such item", 404)
  return new GmailError(
    "upstream_error",
    `Gmail request failed with status ${response.status}`,
    response.status
  )
}
