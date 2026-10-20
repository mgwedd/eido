// Typed failures of the Proton connector. Health (#24) counts them by `code`; nothing here retries.

import { GateUnavailableError } from "@eido/gate"

export type ProtonErrorCode =
  | "handshake_failed"
  | "auth_failed"
  | "gate_unavailable"
  | "busy"
  | "not_found"
  | "no_recipients"

export class ProtonError extends Error {
  override readonly name: string = "ProtonError"
  readonly code: ProtonErrorCode
  // Plain field, not a parameter property: Node runs this file with type stripping only.
  constructor(code: ProtonErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** The gate could not reach Bridge, or Bridge's greeting or TLS failed. */
export class HandshakeFailedError extends ProtonError {
  override readonly name = "HandshakeFailedError"
  constructor(message: string) {
    super("handshake_failed", message)
  }
}

/** Bridge rejected the credentials. Never retried in a loop: the caller stops and reports. */
export class AuthFailedError extends ProtonError {
  override readonly name = "AuthFailedError"
  constructor(message: string) {
    super("auth_failed", message)
  }
}

/** The gate itself could not be reached, so no mail call was made. */
export class GateUnavailableMailError extends ProtonError {
  override readonly name = "GateUnavailableMailError"
  constructor(message: string) {
    super("gate_unavailable", message)
  }
}

/**
 * The gate refused a mail read at its concurrent-read limit (503 `busy`, #219). Health (#24)
 * counts it; the sync run stops without retrying and tries again on its next scheduled run.
 */
export class BusyError extends ProtonError {
  override readonly name = "BusyError"
  constructor(message: string) {
    super("busy", message)
  }
}

/**
 * Maps what a `ProtonMailSource` throws onto the connector's typed errors. The gate client (#195)
 * reports `handshake_failed`, `auth_failed` and `busy` as a string `code`, plus `GateUnavailableError`.
 * Anything else is not a known upstream failure and passes through unchanged.
 */
export function toProtonError(error: unknown): unknown {
  if (error instanceof ProtonError) return error
  if (error instanceof GateUnavailableError)
    return new GateUnavailableMailError(error.message)
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (code === "handshake_failed")
      return new HandshakeFailedError(error.message)
    if (code === "auth_failed") return new AuthFailedError(error.message)
    if (code === "busy") return new BusyError(error.message)
  }
  return error
}
