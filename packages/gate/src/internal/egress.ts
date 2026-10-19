import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { DatabaseSync } from "node:sqlite"
import type { ConnectorOperation } from "@eido/schemas"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import { egressAllowlist, getPinnedManifest } from "./connectors"
import { markGrantRevoked } from "./vault/revocation"
import type { Vault } from "./vault/vault"

type Options = {
  db: DatabaseSync
  vault: Vault
  port?: number
  maxBodyBytes?: number
  timeoutMs?: number
  fetch?: typeof fetch
}

type Route = NonNullable<ConnectorOperation["routes"]>[number]
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly reason: string
  ) {
    super(reason)
  }
}
const fail = (status: number, reason: string): never => {
  throw new Refusal(status, reason)
}
const within = (path: string, prefix: string) =>
  path === prefix ||
  path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
const matches = (path: string, pattern: string) => {
  const actual = path.split("/")
  const template = pattern.split("/")
  return (
    actual.length === template.length &&
    template.every((part, i) =>
      /^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(part)
        ? actual[i] !== ""
        : actual[i] === part
    )
  )
}

function targetURL(raw: string): URL {
  // Check the raw path before WHATWG URL normalizes dot segments away. Repeated encoding,
  // backslashes and escaped delimiters are rejected rather than delegated to upstream routers.
  if (!/^https:\/\//.test(raw) || /[\\\s]/.test(raw))
    return fail(400, "invalid_target")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail(400, "invalid_target")
  }
  if (url.username || url.password || url.port || url.hash)
    return fail(400, "invalid_target")
  const rawPath = /^https:\/\/[^/?#]+([^?#]*)/.exec(raw)?.[1] ?? ""
  if (/%(?:2f|5c|25)/i.test(rawPath)) return fail(400, "invalid_path")
  let path: string
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return fail(400, "invalid_path")
  }
  if (
    path.split("/").some((part) => part === "." || part === "..") ||
    path.includes("//")
  )
    return fail(400, "invalid_path")
  url.pathname = path || "/"
  return url
}

async function bytes(
  stream: AsyncIterable<Uint8Array>,
  limit: number
): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > limit) return fail(502, "body_limit")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function* responseChunks(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      yield next.value
    }
  } finally {
    signal.removeEventListener("abort", abort)
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const STRIP = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "x-eido-connector",
  "x-eido-target",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
])

function selectedRoute(
  db: DatabaseSync,
  connector: string,
  target: URL,
  method: string
): Route {
  const state = db
    .prepare("SELECT enabled, health FROM connectors WHERE name = ?")
    .get(connector)
  if (!state) return fail(404, "connector_unknown")
  if (state["enabled"] !== 1) return fail(423, "connector_disabled")
  if (state["health"] === "open") return fail(503, "connector_open")
  if (!egressAllowlist(db).some((entry) => entry.host === target.hostname))
    return fail(403, "global_host_denied")
  const manifest = getPinnedManifest(db, connector)
  const host = manifest?.egress.hosts.find(
    (entry) => entry.host === target.hostname
  )
  if (!host) return fail(403, "connector_host_denied")
  if (
    !host.methods.some((allowed) => allowed === method) ||
    !host.pathPrefixes.some((prefix) => within(target.pathname, prefix))
  )
    return fail(405, "connector_route_denied")
  const found = (manifest?.operations ?? []).flatMap((operation) =>
    (operation.routes ?? [])
      .filter(
        (route) =>
          route.host === target.hostname &&
          route.method === method &&
          matches(target.pathname, route.pathPattern)
      )
      .map((route) => ({ operation, route }))
  )
  if (!found.length) return fail(406, "operation_route_denied")
  // A broad read route must never shadow a write route, even when pinned together.
  if (found.some(({ operation }) => operation.effect !== "read"))
    return fail(409, "write_operation_denied")
  const match = found[0]
  if (!match) return fail(406, "operation_route_denied")
  return match.route
}

/** Internal listener lifecycle. Only the address/request contract is consumed outside the gate. */
export async function startEgressProxy(
  options: Options
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const { db, vault } = options
  const limit = options.maxBodyBytes ?? 8 * 1024 * 1024
  const timeout = options.timeoutMs ?? 30_000
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1
  )
    throw new Error("invalid egress limits")
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeout)
    const bounded = <T>(promise: Promise<T>): Promise<T> => {
      if (controller.signal.aborted)
        return Promise.reject(new Refusal(502, "upstream_timeout"))
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Refusal(502, "upstream_timeout"))
        controller.signal.addEventListener("abort", abort, { once: true })
        void promise
          .then(resolve, reject)
          .finally(() => controller.signal.removeEventListener("abort", abort))
      })
    }
    const disconnect = () => controller.abort()
    res.on("close", disconnect)
    const work = async () => {
      const connectorHeader = req.headers["x-eido-connector"]
      const connector =
        typeof connectorHeader === "string" ? connectorHeader : ""
      let summary: Record<string, string | number> = {}
      try {
        if (req.url !== "/" || !/^[a-z][a-z0-9-]{0,63}$/.test(connector))
          fail(400, "invalid_request")
        const targetHeader = req.headers["x-eido-target"]
        if (typeof targetHeader !== "string") fail(400, "invalid_target")
        const target = targetURL(
          typeof targetHeader === "string" ? targetHeader : ""
        )
        const method = req.method ?? "GET"
        const route = selectedRoute(db, connector, target, method)
        summary = {
          method,
          host: target.hostname,
          pathTemplate: route.pathPattern,
        }
        const body = await bounded(bytes(req, limit))
        if (method === "GET" && body.length) fail(400, "get_body_denied")
        const token = await bounded(
          vault.get({ connector, kind: "access_token", client: "read" })
        )
        if (!token) fail(424, "credential_missing")
        // Recheck after vault IO: disabling a connector while awaiting a token stops the call.
        selectedRoute(db, connector, target, method)
        const headers = new Headers()
        const connection = (req.headers.connection ?? "")
          .toLowerCase()
          .split(",")
          .map((value) => value.trim())
        for (const [name, value] of Object.entries(req.headers)) {
          if (
            !STRIP.has(name) &&
            !connection.includes(name) &&
            typeof value === "string"
          )
            headers.set(name, value)
        }
        if (controller.signal.aborted) fail(502, "upstream_timeout")
        headers.set("authorization", `Bearer ${token}`)
        const upstream = await bounded(
          (options.fetch ?? fetch)(target, {
            method,
            headers,
            ...(body.length ? { body: new Uint8Array(body) } : {}),
            redirect: "manual",
            signal: controller.signal,
          })
        )
        if (upstream.status === 401) {
          void upstream.body?.cancel().catch(() => undefined)
          await markGrantRevoked(connector, "unauthorized", {
            vault: {
              get: vault.get.bind(vault),
              set: vault.set.bind(vault),
              delete: (key) => bounded(vault.delete(key)),
            },
            connectors: {
              isEnabled: () => Promise.resolve(true),
              disable: () => {
                db.prepare(
                  "UPDATE connectors SET enabled = 0, health = 'open' WHERE name = ?"
                ).run(connector)
                return Promise.resolve()
              },
            },
            audit: {
              append: (entry) => {
                append(db, {
                  actor: "system",
                  action: entry.action,
                  target: connector,
                  detailHash: payloadHash({ reason: entry.errorClass }),
                })
                return Promise.resolve()
              },
            },
          })
          fail(502, "grant_revoked")
        }
        if (upstream.status >= 300 && upstream.status < 400) {
          void upstream.body?.cancel().catch(() => undefined)
          fail(502, "redirect_denied")
        }
        // Bound and inspect before sending headers: neither oversized nor token-echo responses
        // can partially leak. The bounded payload is then released to the caller.
        const responseBody = upstream.body
          ? await bounded(
              bytes(responseChunks(upstream.body, controller.signal), limit)
            )
          : Buffer.alloc(0)
        if (
          token &&
          (responseBody.includes(Buffer.from(token)) ||
            [...upstream.headers.values()].some((value) =>
              value.includes(token)
            ))
        )
          fail(502, "credential_echo")
        if (controller.signal.aborted) fail(502, "upstream_timeout")
        append(db, {
          actor: "system",
          action: "egress_allowed",
          target: connector,
          detailHash: payloadHash({ ...summary, status: upstream.status }),
        })
        res.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        })
        res.end(responseBody)
      } catch (error) {
        const refusal = timedOut
          ? new Refusal(502, "upstream_timeout")
          : error instanceof Refusal
            ? error
            : new Refusal(502, "upstream_failure")
        append(db, {
          actor: "system",
          action: "egress_refused",
          target: /^[a-z][a-z0-9-]{0,63}$/.test(connector)
            ? connector
            : "unknown",
          detailHash: payloadHash({ ...summary, reason: refusal.reason }),
        })
        if (!res.destroyed) {
          res.writeHead(refusal.status, {
            "content-type": "application/json",
            "cache-control": "no-store",
          })
          res.end(JSON.stringify({ reason: refusal.reason }))
        }
      }
    }
    try {
      await work()
    } finally {
      clearTimeout(timer)
      res.off("close", disconnect)
      controller.abort()
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => res.destroy())
  })
  server.requestTimeout = timeout
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("egress listener has no address")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
