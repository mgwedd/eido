// How Bridge failures reach the gate's callers (#195). Core reads `code` (handshake_failed,
// auth_failed) and backs off; nothing else from the library error is passed on, since its
// message can quote the server's response.

export type BridgeErrorCode =
  | "handshake_failed"
  | "auth_failed"
  | "not_found"
  | "unsupported"
  | "bridge_error"

export class BridgeError extends Error {
  override readonly name = "BridgeError"
  readonly code: BridgeErrorCode
  // Plain field, not a parameter property: Node runs this file with type stripping only.
  constructor(code: BridgeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function field(error: unknown, name: string): unknown {
  if (typeof error !== "object" || error === null) return undefined
  const value: unknown = Reflect.get(error, name)
  return value
}

// Node socket codes and imapflow's own codes for "could not open a session".
const IMAP_HANDSHAKE = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ETIMEDOUT",
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectText",
  "ClosedAfterConnectTLS",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "STARTTLS_INJECTION",
])

/** Maps an imapflow (or socket) error to a BridgeError; a BridgeError passes through. */
export function imapError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error
  if (field(error, "authenticationFailed") === true) {
    return new BridgeError(
      "auth_failed",
      "Bridge refused the username or password"
    )
  }
  const code = field(error, "code")
  if (
    field(error, "tlsFailed") === true ||
    (typeof code === "string" && IMAP_HANDSHAKE.has(code))
  ) {
    return new BridgeError(
      "handshake_failed",
      "Bridge IMAP could not be reached"
    )
  }
  return new BridgeError("bridge_error", "Bridge IMAP refused the request")
}

const SMTP_HANDSHAKE = new Set([
  "ECONNECTION",
  "ESOCKET",
  "ETIMEDOUT",
  "ETLS",
  "EDNS",
  "ECONNREFUSED",
])

/** Maps a nodemailer error to a BridgeError; a BridgeError passes through. */
export function smtpError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error
  const code = field(error, "code")
  if (code === "EAUTH" || code === "ENOAUTH") {
    return new BridgeError(
      "auth_failed",
      "Bridge refused the username or password"
    )
  }
  if (typeof code === "string" && SMTP_HANDSHAKE.has(code)) {
    return new BridgeError(
      "handshake_failed",
      "Bridge SMTP could not be reached"
    )
  }
  return new BridgeError("bridge_error", "Bridge SMTP refused the message")
}
