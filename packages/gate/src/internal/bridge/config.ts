import { createHash, X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"

// Proton Bridge settings (#195). Bridge is a local service: IMAP and SMTP on loopback ports,
// usually with a self-signed certificate. The password is not here: it lives in the vault and
// is read only when a connection opens (see bridge.ts).

/** The pinned connector whose intents run through Bridge (core's manifest, #22). */
export const PROTON_CONNECTOR = "proton-mail"

export const BRIDGE_TLS_MODES = ["starttls", "tls"] as const
/** `none` is only for direct test fixtures; bridgeConfig never returns it. */
export type BridgeTlsMode = (typeof BRIDGE_TLS_MODES)[number] | "none"

// Loopback addresses only. A name such as localhost is refused: the resolver (hosts file, DNS)
// decides where a name points, and could send the password off this machine.
export const BRIDGE_HOSTS = ["127.0.0.1", "::1"] as const
export type BridgeHost = (typeof BRIDGE_HOSTS)[number]

export type BridgeConfig = {
  host: BridgeHost
  imapPort: number
  smtpPort: number
  tls: BridgeTlsMode
  /** Exported Bridge certificate, trusted only when its fingerprint matches. */
  certificatePem?: string
  certificateSha256?: string
  /** The Bridge username, which is also the assistant identity mail is sent from. */
  username: string
  /** Folders searched, in order, to find a message by its Message-ID. */
  searchFolders: readonly string[]
}

type Env = Readonly<Record<string, string | undefined>>

const NAMES = {
  host: "EIDO_BRIDGE_HOST",
  imapPort: "EIDO_BRIDGE_IMAP_PORT",
  smtpPort: "EIDO_BRIDGE_SMTP_PORT",
  username: "EIDO_BRIDGE_USERNAME",
  tls: "EIDO_BRIDGE_TLS",
  certificatePath: "EIDO_BRIDGE_CERT_PATH",
  certificateSha256: "EIDO_BRIDGE_CERT_SHA256",
  searchFolders: "EIDO_BRIDGE_SEARCH_FOLDERS",
} as const

function port(env: Env, name: string): number {
  const value = env[name] ?? ""
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(
      `${name} must be a port number, not ${JSON.stringify(value)}`
    )
  }
  return Number(value)
}

function oneOf<T extends string>(
  values: readonly T[],
  name: string,
  value: string
): T {
  const found = values.find((entry) => entry === value)
  if (found === undefined) {
    throw new Error(
      `${name} must be one of ${values.join(", ")}, not ${JSON.stringify(value)}`
    )
  }
  return found
}

/**
 * The Bridge settings from the gate's environment, or undefined when EIDO_BRIDGE_HOST is not
 * set (the gate then serves no mail routes). Throws naming the first bad or missing variable.
 * Only loopback hosts are accepted: the gate's mail egress goes to Bridge on this machine only.
 */
export function bridgeConfig(env: Env): BridgeConfig | undefined {
  const host = env[NAMES.host] ?? ""
  if (host === "") return undefined
  const username = env[NAMES.username] ?? ""
  if (username === "") throw new Error(`the gate needs ${NAMES.username}`)
  if (env["EIDO_BRIDGE_ALLOW_SELF_SIGNED"] !== undefined) {
    throw new Error(
      "EIDO_BRIDGE_ALLOW_SELF_SIGNED is unsupported; pin Bridge's certificate"
    )
  }
  const certificatePath = env[NAMES.certificatePath] ?? ""
  const certificateSha256 = env[NAMES.certificateSha256] ?? ""
  if (certificatePath === "")
    throw new Error(`the gate needs ${NAMES.certificatePath}`)
  if (!/^[0-9a-f]{64}$/.test(certificateSha256)) {
    throw new Error(
      `${NAMES.certificateSha256} must be 64 lowercase hex characters`
    )
  }
  let certificatePem: string
  try {
    certificatePem = readFileSync(certificatePath, "utf8")
    if (certificatePem.includes("PRIVATE KEY")) {
      throw new Error("Bridge certificate file must not contain a private key")
    }
    const certificate = new X509Certificate(certificatePem)
    const actual = createHash("sha256").update(certificate.raw).digest("hex")
    if (actual !== certificateSha256) {
      throw new Error(
        "Bridge certificate fingerprint does not match the configured pin"
      )
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("Bridge certificate fingerprint") ||
        error.message.startsWith("Bridge certificate file"))
    )
      throw error
    throw new Error("cannot read the configured Bridge certificate")
  }
  const folders = (env[NAMES.searchFolders] ?? "INBOX")
    .split(",")
    .map((folder) => folder.trim())
    .filter((folder) => folder !== "")
  return {
    host: oneOf(BRIDGE_HOSTS, NAMES.host, host),
    imapPort: port(env, NAMES.imapPort),
    smtpPort: port(env, NAMES.smtpPort),
    tls: oneOf(BRIDGE_TLS_MODES, NAMES.tls, env[NAMES.tls] ?? "starttls"),
    certificatePem,
    certificateSha256,
    username,
    searchFolders: folders.length === 0 ? ["INBOX"] : folders,
  }
}
