import type { AddressInfo } from "node:net"
import type { GateConnectorHealth } from "@eido/schemas"
import type { AskResult } from "../ask/types"
import type { ObligationStateStore } from "../ledger/obligation-state"
import type { ProfileStore } from "../profile/store"
import type { DocumentsDeps } from "./documents-route"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"
import { createApiServer } from "./server"

// Core's API has no auth of its own: the tailnet is the trust boundary, and `tailscale serve`
// (#178) is the only way in from it. So core listens on loopback only, and answers only the
// Host headers it is given (DNS rebinding).

/** The only addresses core's API binds to. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number]

/** `value` as a loopback address; anything else (a LAN address, `0.0.0.0`, a name) throws. */
export function loopbackHost(value: string): LoopbackHost {
  const host = LOOPBACK_HOSTS.find((candidate) => candidate === value)
  if (host === undefined) {
    throw new Error(
      `core's API binds to 127.0.0.1 or ::1 only, not ${JSON.stringify(value)}`
    )
  }
  return host
}

// Each segment is unreserved characters, and never `.` or `..`.
const BASE_PATH = /^(\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)+$/

/** `value` as a base path: empty, or segments like `/api/core` with no trailing slash, `.` or `..`. */
export function basePath(value: string): string {
  if (value !== "" && !BASE_PATH.test(value)) {
    throw new Error(
      `the base path must look like /api/core, not ${JSON.stringify(value)}`
    )
  }
  return value
}

/** The Host header a client sends for the listen address. */
export function hostHeader(host: LoopbackHost, port: number): string {
  return host === "::1" ? `[::1]:${String(port)}` : `${host}:${String(port)}`
}

/** The listener's own Host appears once, even if configured as an extra allowed Host. */
export function withListenHost(
  listenHost: string,
  allowedHosts: readonly string[]
): string[] {
  return [
    listenHost,
    ...allowedHosts.filter((allowed) => allowed !== listenHost),
  ]
}

export type CoreApiOptions = {
  profile: ProfileStore
  /** Gate-owned read-only connector health projection for the Today page. */
  connectorHealth?: () => Promise<GateConnectorHealth["connectors"]>
  ask?: (question: string) => Promise<AskResult>
  obligations?: ObligationStateStore
  /** The data DB behind `/documents`. */
  documents?: DocumentsDeps
  host: LoopbackHost
  /** 0 picks a free port. */
  port: number
  basePath: string
  /** Host headers answered besides the listen address itself, such as the one serve forwards. */
  allowedHosts: readonly string[]
}

export type CoreApi = {
  host: LoopbackHost
  port: number
  /** Every Host header answered: the listen address, then the configured ones. */
  allowedHosts: readonly string[]
  close: () => Promise<void>
}

/** Starts core's API on a loopback address and resolves once it is listening. */
export async function listenCoreApi(options: CoreApiOptions): Promise<CoreApi> {
  // The listen address carries the port, which is known only once the server listens. Until
  // then no Host is allowed, so nothing is answered with anything but 421.
  const handlerFor = (allowedHosts: readonly string[]): ApiHandler =>
    createApiHandler({
      profile: options.profile,
      connectorHealth: options.connectorHealth,
      ask: options.ask,
      obligations: options.obligations,
      documents: options.documents,
      allowedHosts,
      basePath: options.basePath,
    })
  let handler = handlerFor([])
  const server = createApiServer((request) => handler(request))
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, () => {
      server.off("error", reject)
      resolve()
    })
  })
  // listen on a host and port always yields an AddressInfo, never a pipe name.
  const { port } = server.address() as AddressInfo
  const listenHost = hostHeader(options.host, port)
  const allowedHosts = withListenHost(listenHost, options.allowedHosts)
  handler = handlerFor(allowedHosts)
  return {
    host: options.host,
    port,
    allowedHosts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
