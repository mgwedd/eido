import type { AddressInfo } from "node:net"
import type { ProfileStore } from "../profile/store"
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

const BASE_PATH = /^(\/[A-Za-z0-9._~-]+)+$/

/** `value` as a base path: empty, or segments like `/api/core` with no trailing slash. */
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

export type CoreApiOptions = {
  profile: ProfileStore
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
  const allowedHosts = [
    listenHost,
    ...options.allowedHosts.filter((allowed) => allowed !== listenHost),
  ]
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
