import { connect as netConnect } from "node:net"
import type { Duplex } from "node:stream"
import { connect as tlsConnect } from "node:tls"
import type { ProtonConfig, TlsMode } from "./config"
import { HandshakeFailedError } from "./errors"

// The connector reaches Bridge only through an injected ConnectionFactory. The factory is where
// the Bridge password enters: the gate-side adapter (a separate issue) holds the vault secret and
// answers `authenticate` by composing the LOGIN or AUTH line itself. This package sees the
// username, host and port, and the server's reply to the login, never the password.

export type Protocol = "imap" | "smtp"

export type Endpoint = {
  protocol: Protocol
  host: string
  port: number
  tls: TlsMode
  username: string
  allowSelfSigned: boolean
  timeoutMs: number
}

/** A server reply reduced to what login needs: success or not, plus its text for diagnostics. */
export type Reply = { ok: boolean; text: string }

/** Lets the adapter run its login exchange without this package handling the secret. */
export type AuthSession = {
  /** IMAP: a command line (the session adds the tag). SMTP: a command line. */
  send: (line: string) => Promise<Reply>
}

export type Connection = {
  stream: Duplex
  /** Present when `tls` is "starttls": upgrades the socket in place after the server says go. */
  upgradeTls?: () => Promise<Duplex>
  /** Logs in with the vault's secret. Resolves with the server's reply; ok false means auth_failed. */
  authenticate: (session: AuthSession) => Promise<Reply>
}

export type ConnectionFactory = (endpoint: Endpoint) => Promise<Connection>

export function endpointFor(
  config: ProtonConfig,
  protocol: Protocol
): Endpoint {
  return {
    protocol,
    host: config.host,
    port: protocol === "imap" ? config.imapPort : config.smtpPort,
    tls: protocol === "imap" ? config.imapTls : config.smtpTls,
    username: config.username,
    allowSelfSigned: config.allowSelfSigned,
    timeoutMs: config.timeoutMs,
  }
}

export type Socket = Pick<Connection, "stream" | "upgradeTls">

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "connection failed"
}

/**
 * Opens the raw socket for an endpoint, without credentials. A factory (the gate adapter, or a
 * test) wraps this and adds `authenticate`. Any failure becomes HandshakeFailedError.
 */
export function openSocket(endpoint: Endpoint): Promise<Socket> {
  const { host, port, tls, timeoutMs } = endpoint
  const tlsOptions = {
    rejectUnauthorized: !endpoint.allowSelfSigned,
    servername: /^[\d.:]+$/.test(host) ? undefined : host,
  }
  return new Promise((resolve, reject) => {
    const socket =
      tls === "implicit"
        ? tlsConnect({ host, port, ...tlsOptions })
        : netConnect({ host, port })
    const fail = (error: unknown) => {
      socket.destroy()
      reject(new HandshakeFailedError(describe(error)))
    }
    socket.setTimeout(timeoutMs, () =>
      fail(new Error(`no connection within ${timeoutMs} ms`))
    )
    socket.once("error", fail)
    socket.once(tls === "implicit" ? "secureConnect" : "connect", () => {
      socket.off("error", fail)
      socket.setTimeout(0)
      resolve({
        stream: socket,
        ...(tls === "starttls"
          ? {
              upgradeTls: () =>
                new Promise<Duplex>((done, failed) => {
                  const secure = tlsConnect({ socket, ...tlsOptions })
                  secure.once("error", (error) =>
                    failed(new HandshakeFailedError(describe(error)))
                  )
                  secure.once("secureConnect", () => done(secure))
                }),
            }
          : {}),
      })
    })
  })
}
