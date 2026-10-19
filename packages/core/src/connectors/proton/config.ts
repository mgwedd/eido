// Non-secret connection settings. There is deliberately no password field: the Bridge password is a
// vault secret that only the gate adds at connect time (see connection.ts).

export type TlsMode = "starttls" | "implicit" | "none"

export type ProtonConfig = {
  host: string
  imapPort: number
  smtpPort: number
  /** The Bridge account, which is also the sending identity (the assistant address). */
  username: string
  imapTls: TlsMode
  smtpTls: TlsMode
  /** Bridge presents a self-signed certificate for localhost; only valid for loopback hosts. */
  allowSelfSigned: boolean
  trashFolder: string
  draftsFolder: string
  /** Folders mirrored into the local index. */
  folders: readonly string[]
  batchSize: number
  timeoutMs: number
}

/** Bridge's defaults: loopback, IMAP 1143 and SMTP 1025, both STARTTLS. */
export const BRIDGE_DEFAULTS = {
  host: "127.0.0.1",
  imapPort: 1143,
  smtpPort: 1025,
  imapTls: "starttls",
  smtpTls: "starttls",
  allowSelfSigned: true,
  trashFolder: "Trash",
  draftsFolder: "Drafts",
  folders: ["INBOX"],
  batchSize: 50,
  timeoutMs: 10_000,
} as const satisfies Partial<ProtonConfig>

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])

export function resolveConfig(
  input: Partial<ProtonConfig> & Pick<ProtonConfig, "username">
): ProtonConfig {
  const config: ProtonConfig = {
    ...BRIDGE_DEFAULTS,
    folders: [...BRIDGE_DEFAULTS.folders],
    ...input,
  }
  for (const [name, port] of [
    ["imapPort", config.imapPort],
    ["smtpPort", config.smtpPort],
  ] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new RangeError(`${name} must be a port number`)
  }
  if (config.batchSize < 1 || !Number.isInteger(config.batchSize))
    throw new RangeError("batchSize must be a positive integer")
  if (!config.username.includes("@"))
    throw new RangeError("username must be an address")
  if (config.allowSelfSigned && !LOOPBACK.has(config.host))
    throw new RangeError("allowSelfSigned is only valid for a loopback host")
  return config
}
