// Measures what `tailscale serve` forwards (#178): for each Eido route, which path, which Host
// header and whether Tailscale-User-Login reach the backend. It starts a loopback echo server on
// each route's target port in place of Next, core and the gate, requests each route through the
// serve origin, and reports what the echo server saw. The report replaces the node's name with
// <host>, so it can be pasted into a public issue.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import type { Route } from "./serve-routes.ts"

export type Seen = {
  backend: Route["name"]
  path: string
  host: string
  userLogin: boolean
}

export type EchoServers = {
  /** The bound port per backend (the route's port, or a free one when it was 0). */
  ports: Record<Route["name"], number>
  close: () => Promise<void>
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/** Starts one echo server per route on 127.0.0.1 at the route's target port. */
export async function startEchoServers(
  routes: readonly Route[]
): Promise<EchoServers> {
  const servers: Server[] = []
  const ports = {} as Record<Route["name"], number>
  const close = () =>
    Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections()
          })
      )
    ).then(() => undefined)
  try {
    for (const route of routes) {
      const server = createServer((req, res) => {
        const seen: Seen = {
          backend: route.name,
          path: req.url ?? "",
          host: req.headers.host ?? "",
          userLogin: req.headers["tailscale-user-login"] !== undefined,
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(seen))
      })
      servers.push(server)
      ports[route.name] = await listen(
        server,
        Number(new URL(route.target).port)
      )
    }
  } catch (error) {
    await close()
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(
      code === "EADDRINUSE"
        ? "a route's target port is in use; stop Next, core and the gate before measuring"
        : `could not start the echo servers: ${String(error)}`
    )
  }
  return { ports, close }
}

/** The request made through serve for each route. */
export const PROBES: readonly { route: Route["name"]; path: string }[] = [
  { route: "web", path: "/eido-probe?q=1" },
  { route: "core", path: "/api/core/profile?q=1" },
  { route: "gate", path: "/api/gate/passkey/status" },
]

export type Fetch = (
  url: string
) => Promise<{ status: number; text: () => Promise<string> }>

/** Requests each probe through `origin` and returns what the backend saw, in probe order. */
export async function probe(
  origin: string,
  fetchUrl: Fetch
): Promise<(Seen | string)[]> {
  const results: (Seen | string)[] = []
  for (const { path } of PROBES) {
    try {
      const response = await fetchUrl(`${origin}${path}`)
      const body = await response.text()
      if (response.status !== 200) {
        results.push(`HTTP ${response.status}`)
        continue
      }
      results.push(JSON.parse(body) as Seen)
    } catch (error) {
      results.push(`request failed: ${String(error)}`)
    }
  }
  return results
}

/** Markdown lines for the ADR and the issue comments, with the node's name replaced by <host>. */
export function report(
  results: readonly (Seen | string)[],
  dnsName: string,
  port: number
): string[] {
  const redact = (text: string) => text.split(dnsName).join("<host>")
  const lines = [
    `Measured through https://<host>:${port} with echo servers on the route targets:`,
    "",
    "| Request | Reached | Path seen | Host seen | Tailscale-User-Login |",
    "| --- | --- | --- | --- | --- |",
  ]
  PROBES.forEach((probe, i) => {
    const seen = results[i]
    const request = `\`${probe.path}\``
    if (seen === undefined || typeof seen === "string") {
      lines.push(`| ${request} | ${redact(seen ?? "no result")} | | | |`)
      return
    }
    const reached =
      seen.backend === probe.route
        ? seen.backend
        : `${seen.backend} (expected ${probe.route})`
    lines.push(
      `| ${request} | ${reached} | \`${redact(seen.path)}\` | \`${redact(seen.host)}\` | ${seen.userLogin ? "present" : "absent"} |`
    )
  })
  return lines
}
