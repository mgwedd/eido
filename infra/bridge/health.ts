// The Bridge health check: connect to the configured host and ports and read the server greeting
// from IMAP (`* OK`) and SMTP (`220`). Bridge's default is STARTTLS, so both greet in clear text
// before any TLS; no credential is sent, so the check cannot leak one. The host and ports are the
// gate's EIDO_BRIDGE_* variables and are never defaulted: Bridge picks its own free ports.
import { connect } from "node:net"

/** Loopback only, as the gate accepts (packages/gate/src/internal/bridge/config.ts). */
export const HOSTS = ["127.0.0.1", "::1"] as const
export type BridgeEndpoint = {
  host: (typeof HOSTS)[number]
  imapPort: number
  smtpPort: number
}

type Env = Readonly<Record<string, string | undefined>>

function portFrom(env: Env, name: string): number {
  const value = env[name] ?? ""
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new Error(
      `${name} must be a port number (read it from Bridge's info command), not ${JSON.stringify(value)}`
    )
  return Number(value)
}

/** The endpoint from EIDO_BRIDGE_HOST, EIDO_BRIDGE_IMAP_PORT and EIDO_BRIDGE_SMTP_PORT. */
export function endpointFromEnv(env: Env): BridgeEndpoint {
  const host = HOSTS.find((entry) => entry === env["EIDO_BRIDGE_HOST"])
  if (host === undefined)
    throw new Error(
      `EIDO_BRIDGE_HOST must be one of ${HOSTS.join(", ")}, not ${JSON.stringify(env["EIDO_BRIDGE_HOST"] ?? "")}`
    )
  return {
    host,
    imapPort: portFrom(env, "EIDO_BRIDGE_IMAP_PORT"),
    smtpPort: portFrom(env, "EIDO_BRIDGE_SMTP_PORT"),
  }
}

export type Protocol = "imap" | "smtp"

const GREETING = {
  imap: /^\* OK[ \r\n]/,
  smtp: /^220[ -]/,
} as const satisfies Record<Protocol, RegExp>

/** True when `greeting` is the first line a healthy `protocol` server sends. */
export function isGreeting(protocol: Protocol, greeting: string): boolean {
  return GREETING[protocol].test(greeting)
}

/** Opens a connection and resolves with the server's first bytes, or rejects with the reason. */
export type ReadGreeting = (
  host: string,
  port: number,
  timeoutMs: number
) => Promise<string>

export type ProbeResult = { protocol: Protocol; port: number; error?: string }

export const TIMEOUT_MS = 5000

export async function probe(
  endpoint: BridgeEndpoint,
  readGreeting: ReadGreeting,
  timeoutMs = TIMEOUT_MS
): Promise<ProbeResult[]> {
  const targets = [
    { protocol: "imap", port: endpoint.imapPort },
    { protocol: "smtp", port: endpoint.smtpPort },
  ] as const
  return Promise.all(
    targets.map(async ({ protocol, port }): Promise<ProbeResult> => {
      try {
        const greeting = await readGreeting(endpoint.host, port, timeoutMs)
        if (isGreeting(protocol, greeting)) return { protocol, port }
        return {
          protocol,
          port,
          error: `unexpected greeting (is implicit TLS on? the check expects STARTTLS)`,
        }
      } catch (error) {
        return {
          protocol,
          port,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
  )
}

/** The real greeting reader over a TCP socket. */
export const readGreetingOverTcp: ReadGreeting = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    const done = (finish: () => void) => {
      socket.destroy()
      finish()
    }
    socket.setTimeout(timeoutMs, () =>
      done(() => reject(new Error(`no greeting within ${timeoutMs} ms`)))
    )
    socket.once("error", (error) => done(() => reject(error)))
    socket.once("close", () =>
      done(() => reject(new Error("closed before a greeting")))
    )
    socket.once("data", (data) => done(() => resolve(data.toString("utf8"))))
  })
