// Typed failures of the Proton connector. Health (#24) counts them by `code`; nothing here retries.

export type ProtonErrorCode =
  | "handshake_failed"
  | "auth_failed"
  | "protocol_error"
  | "unsafe_command"
  | "not_found"

export class ProtonError extends Error {
  override readonly name: string = "ProtonError"
  readonly code: ProtonErrorCode
  // Plain field, not a parameter property: Node runs this file with type stripping only.
  constructor(code: ProtonErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** The connection was refused, timed out, failed TLS, or the server's greeting was not a success. */
export class HandshakeFailedError extends ProtonError {
  override readonly name = "HandshakeFailedError"
  constructor(message: string) {
    super("handshake_failed", message)
  }
}

/** The server rejected the credentials. Never retried in a loop: the caller stops and reports. */
export class AuthFailedError extends ProtonError {
  override readonly name = "AuthFailedError"
  constructor(message: string) {
    super("auth_failed", message)
  }
}
