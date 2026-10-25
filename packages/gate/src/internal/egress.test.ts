import { afterEach, describe, expect, test, vi } from "vitest"
import type { ConnectorManifest } from "@eido/schemas"
import { startEgressProxy } from "./egress"
import { checkDrift } from "./connectors"
import { openControlDb } from "./control-db"
import { signedPin } from "./test-fixtures"
import { verifyChain } from "./audit"
import { payloadHash } from "./canonical"
import { InMemoryVault } from "./vault/vault"

const TOKEN = "synthetic-read-token-secret"
function fixture(): ConnectorManifest {
  return {
    name: "mail",
    version: 1,
    description: "Synthetic mail",
    auth: { type: "oauth2", scopes: [] },
    egress: {
      hosts: [
        {
          host: "api.example.com",
          methods: ["GET", "POST"],
          pathPrefixes: ["/v1"],
        },
      ],
    },
    operations: [
      {
        name: "read",
        effect: "read",
        reversibility: "reversible",
        sensitivity: "normal",
        untrustedOutput: true,
        authScopes: [],
        defaultTier: "auto",
        routes: [
          {
            host: "api.example.com",
            method: "GET",
            pathPattern: "/v1/messages/{id}",
          },
        ],
      },
      {
        name: "send",
        effect: "write",
        reversibility: "irreversible",
        sensitivity: "normal",
        untrustedOutput: false,
        authScopes: [],
        defaultTier: "approval",
        intentKind: "email.send",
        routes: [
          { host: "api.example.com", method: "POST", pathPattern: "/v1/send" },
        ],
      },
    ],
    triggers: [],
    ledgerMapping: { source: "mail", refField: "id" },
    health: {
      backoff: { baseMs: 1, maxMs: 2, jitter: false },
      breaker: { failureThreshold: 3, halfOpenProbeAfterMs: 10 },
    },
  }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function setup(
  overrides: Partial<Parameters<typeof startEgressProxy>[0]> = {},
  manifest = fixture()
) {
  const db = openControlDb(":memory:")
  signedPin(db, manifest, "owner")
  const vault = new InMemoryVault()
  await vault.set(
    { connector: "mail", kind: "access_token", client: "read" },
    TOKEN
  )
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(
    new Response("message-content", {
      headers: { "content-type": "text/plain" },
    })
  )
  const proxy = await startEgressProxy({
    db,
    vault,
    fetch: upstream,
    ...overrides,
  })
  cleanups.push(async () => {
    await proxy.close()
    db.close()
  })
  const request = (
    target = "https://api.example.com/v1/messages/one?private=query",
    method = "GET",
    extra: Record<string, string> = {}
  ) =>
    fetch(proxy.baseUrl, {
      method,
      headers: {
        "x-eido-connector": "mail",
        "x-eido-target": target,
        ...extra,
      },
    })
  return { db, vault, upstream, request, proxy }
}
function audits(db: ReturnType<typeof openControlDb>) {
  return db
    .prepare(
      "SELECT action, detail_hash FROM audit_log WHERE action LIKE 'egress_%'"
    )
    .all()
}

describe("read egress proxy", () => {
  test("invariant: proxy refuses hosts, methods, and paths outside the pinned manifest", async () => {
    const { request, upstream } = await setup()
    const cases = [
      ["https://other.example.com/v1/messages/one", "GET", 403],
      ["https://api.example.com/v1/messages/one", "DELETE", 405],
      ["https://api.example.com/v1/secrets", "GET", 406],
    ] as const

    for (const [target, method, status] of cases) {
      const response = await request(target, method)
      expect(response.status).toBe(status)
      expect(upstream).not.toHaveBeenCalled()
    }
  })

  test.each([
    [
      "https://other.example.com/v1/messages/one",
      "GET",
      403,
      "global_host_denied",
    ],
    [
      "https://api.example.com/v1/messages/one",
      "DELETE",
      405,
      "connector_route_denied",
    ],
    [
      "https://api.example.com/v10/messages/one",
      "GET",
      405,
      "connector_route_denied",
    ],
    [
      "https://api.example.com/v1/secrets",
      "GET",
      406,
      "operation_route_denied",
    ],
    ["https://api.example.com/v1/messages/../send", "GET", 400, "invalid_path"],
    [
      "https://api.example.com/v1/messages/%2e%2e/send",
      "GET",
      400,
      "invalid_path",
    ],
    ["https://api.example.com/v1/messages/a%2fb", "GET", 400, "invalid_path"],
    ["https://api.example.com/v1/messages/a%252fb", "GET", 400, "invalid_path"],
    [
      "https://user@api.example.com/v1/messages/one",
      "GET",
      400,
      "invalid_target",
    ],
    [
      "https://api.example.com:8443/v1/messages/one",
      "GET",
      400,
      "invalid_target",
    ],
    [
      "https://api.example.com/v1/messages/one#fragment",
      "GET",
      400,
      "invalid_target",
    ],
    ["http://api.example.com/v1/messages/one", "GET", 400, "invalid_target"],
    ["not-a-url", "GET", 400, "invalid_target"],
    ["https://api.example.com/v1/send", "POST", 409, "write_operation_denied"],
  ])("refuses %s %s", async (target, method, status, reason) => {
    const { request, upstream, db } = await setup()
    const response = await request(target, method)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ reason })
    expect(upstream).not.toHaveBeenCalled()
    expect(audits(db)).toEqual([
      { action: "egress_refused", detail_hash: payloadHash({ reason }) },
    ])
    expect(verifyChain(db)).toEqual({ ok: true, rows: 2 })
  })
  test("global host from another connector still needs connector permission", async () => {
    const { db, request, upstream } = await setup()
    const other = fixture()
    other.name = "other"
    other.egress.hosts = [
      { host: "other.example.com", methods: ["GET"], pathPrefixes: ["/v1"] },
    ]
    other.operations.forEach((op) => delete op.routes)
    signedPin(db, other, "owner")
    expect(
      await (await request("https://other.example.com/v1/messages/one")).json()
    ).toEqual({ reason: "connector_host_denied" })
    expect(upstream).not.toHaveBeenCalled()
  })
  test("forwards pinned reads with read token, stripping caller credentials and query from audit", async () => {
    const { request, upstream, db } = await setup()
    const response = await request(undefined, undefined, {
      authorization: "Bearer attacker",
      cookie: "session=attacker",
      "x-http-method-override": "DELETE",
      "x-http-method": "PATCH",
      "x-method-override": "POST",
    })
    expect(await response.text()).toBe("message-content")
    const call = upstream.mock.calls[0]
    expect(call?.[0] instanceof URL ? call[0].href : call?.[0]).toBe(
      "https://api.example.com/v1/messages/one?private=query"
    )
    const headers = new Headers(call?.[1]?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(headers.has("cookie")).toBe(false)
    expect(headers.has("host")).toBe(false)
    expect(headers.has("x-http-method-override")).toBe(false)
    expect(headers.has("x-http-method")).toBe(false)
    expect(headers.has("x-method-override")).toBe(false)
    expect(call?.[1]?.redirect).toBe("manual")
    expect(audits(db)).toEqual([
      {
        action: "egress_allowed",
        detail_hash: payloadHash({
          method: "GET",
          host: "api.example.com",
          pathTemplate: "/v1/messages/{id}",
          status: 200,
        }),
      },
    ])
    const auditText = JSON.stringify(
      db.prepare("SELECT * FROM audit_log").all()
    )
    expect(auditText).not.toContain(TOKEN)
    expect(auditText).not.toContain("private=query")
    expect(verifyChain(db)).toEqual({ ok: true, rows: 2 })
  })
  test.each([
    [0, "healthy", 423],
    [1, "open", 503],
  ])(
    "disabled/open connector never contacts upstream",
    async (enabled, health, status) => {
      const { db, request, upstream } = await setup()
      db.prepare("UPDATE connectors SET enabled = ?, health = ?").run(
        enabled,
        health
      )
      expect((await request()).status).toBe(status)
      expect(upstream).not.toHaveBeenCalled()
    }
  )
  test("one due half-open read is admitted and its observed response closes the breaker", async () => {
    const { db, request, upstream } = await setup({ now: () => 2_000 })
    db.prepare(
      `UPDATE connectors SET health = 'open', consecutive_failures = 3,
       next_attempt_at = ?, last_error = 'handshake_failed' WHERE name = 'mail'`
    ).run(new Date(2_000).toISOString())
    let finishProbe: ((response: Response) => void) | undefined
    upstream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve
        })
    )

    const probe = request()
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce())
    const competing = await request()
    expect(competing.status).toBe(503)
    expect(await competing.json()).toEqual({ reason: "connector_open" })
    expect(upstream).toHaveBeenCalledOnce()

    finishProbe?.(new Response("message-content"))
    expect((await probe).status).toBe(200)
    expect(
      db
        .prepare(
          "SELECT health, consecutive_failures, next_attempt_at FROM connectors WHERE name = 'mail'"
        )
        .get()
    ).toMatchObject({
      health: "healthy",
      consecutive_failures: 0,
      next_attempt_at: null,
    })
  })

  test("a failed half-open read stays open and schedules another delay", async () => {
    const { db, request, upstream } = await setup({
      now: () => 4_000,
      random: () => 0,
    })
    db.prepare(
      `UPDATE connectors SET health = 'open', consecutive_failures = 3,
       next_attempt_at = ?, last_error = 'handshake_failed' WHERE name = 'mail'`
    ).run(new Date(4_000).toISOString())
    upstream.mockRejectedValueOnce(new Error("synthetic connection refused"))

    expect((await request()).status).toBe(502)
    expect(
      db
        .prepare(
          "SELECT health, consecutive_failures, last_error, next_attempt_at FROM connectors WHERE name = 'mail'"
        )
        .get()
    ).toMatchObject({
      health: "open",
      consecutive_failures: 4,
      last_error: "handshake_failed",
      next_attempt_at: new Date(4_010).toISOString(),
    })
  })

  test("unknown connectors fail first", async () => {
    const { request, upstream } = await setup()
    expect(
      (await request(undefined, undefined, { "x-eido-connector": "missing" }))
        .status
    ).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })
  test("legacy manifests without operation routes fail closed", async () => {
    const manifest = fixture()
    manifest.operations.forEach((op) => delete op.routes)
    const { request, upstream } = await setup({}, manifest)
    expect((await request()).status).toBe(406)
    expect(upstream).not.toHaveBeenCalled()
  })
  test("overlapping read routes cannot shadow a write", async () => {
    const manifest = fixture()
    const write = manifest.operations[1]
    if (!write) throw new Error("missing fixture")
    write.routes = [
      {
        host: "api.example.com",
        method: "GET",
        pathPattern: "/v1/messages/one",
      },
    ]
    const { request, upstream } = await setup({}, manifest)
    expect((await request()).status).toBe(409)
    expect(upstream).not.toHaveBeenCalled()
  })
  test.each(["location", "set-cookie", "x-arbitrary"])(
    "suppresses token echo in %s",
    async (header) => {
      const { request, upstream } = await setup()
      upstream.mockResolvedValue(
        new Response("ok", { headers: { [header]: TOKEN } })
      )
      const response = await request()
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain(TOKEN)
    }
  )
  test("suppresses token echo across response chunks", async () => {
    const { request, upstream } = await setup()
    upstream.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(TOKEN.slice(0, 9)))
            controller.enqueue(new TextEncoder().encode(TOKEN.slice(9)))
            controller.close()
          },
        })
      )
    )
    const response = await request()
    expect(await response.json()).toEqual({ reason: "credential_echo" })
  })
  test("never follows redirects", async () => {
    const { request, upstream } = await setup()
    upstream.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example.com/" },
      })
    )
    expect(await (await request()).json()).toEqual({
      reason: "redirect_denied",
    })
    expect(upstream).toHaveBeenCalledTimes(1)
  })
  test("revoked grant disables connector and drops all access clients", async () => {
    const { request, upstream, db, vault } = await setup()
    upstream.mockResolvedValue(new Response(null, { status: 401 }))
    expect(await (await request()).json()).toEqual({ reason: "grant_revoked" })
    expect(
      await vault.get({
        connector: "mail",
        client: "read",
        kind: "access_token",
      })
    ).toBeUndefined()
    expect((await request()).status).toBe(423)
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(verifyChain(db)).toEqual({ ok: true, rows: 4 })
  })
  test("caps streamed response bytes before success headers", async () => {
    const { request } = await setup({ maxBodyBytes: 3 })
    expect(await (await request()).json()).toEqual({ reason: "body_limit" })
  })
  test("missing credential never contacts upstream", async () => {
    const { vault, request, upstream } = await setup()
    await vault.delete({
      connector: "mail",
      client: "read",
      kind: "access_token",
    })
    expect((await request()).status).toBe(424)
    expect(upstream).not.toHaveBeenCalled()
  })
  test("timeout covers fetch that ignores cancellation", async () => {
    const { request, upstream, db } = await setup({ timeoutMs: 30 })
    upstream.mockImplementation(() => new Promise(() => {}))
    expect(await (await request()).json()).toEqual({
      reason: "upstream_timeout",
    })
    expect(audits(db)).toHaveLength(1)
  })
  test("timeout covers response consumption", async () => {
    const { request, upstream } = await setup({ timeoutMs: 30 })
    upstream.mockResolvedValue(new Response(new ReadableStream()))
    expect(await (await request()).json()).toEqual({
      reason: "upstream_timeout",
    })
  })
  test("manifest drift disables a previously allowed connector", async () => {
    const { request, upstream, db } = await setup()
    checkDrift(db, "mail", ["unexpected"])
    expect((await request()).status).toBe(423)
    expect(upstream).not.toHaveBeenCalled()
    expect(verifyChain(db)).toEqual({ ok: true, rows: 3 })
  })
  test.each([
    ["https://api.example.com/v1/messages/%zz", "invalid_path"],
    ["https://api.example.com/v1/messages/a\\b", "invalid_target"],
    ["https://api.example.com/v1//messages/one", "invalid_path"],
    ["https://[malformed/v1", "invalid_target"],
  ])("rejects malformed URL %s", async (target, reason) => {
    const { request, upstream } = await setup()
    expect(await (await request(target)).json()).toEqual({ reason })
    expect(upstream).not.toHaveBeenCalled()
  })
  test("query containing a slash does not become a target path", async () => {
    const { request, upstream } = await setup()
    expect(
      (await request("https://api.example.com?q=/v1/messages/one")).status
    ).toBe(405)
    expect(upstream).not.toHaveBeenCalled()
  })
  test.each([
    {},
    { "x-eido-connector": "Bad" },
    { "x-eido-connector": "mail" },
  ])("rejects invalid request headers", async (headers) => {
    const { proxy, upstream } = await setup()
    const requestHeaders = new Headers()
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string") requestHeaders.set(name, value)
    }
    expect(
      (await fetch(proxy.baseUrl, { headers: requestHeaders })).status
    ).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })
  test("rejects a request to a different listener route", async () => {
    const { proxy } = await setup()
    expect((await fetch(`${proxy.baseUrl}/api/gate`)).status).toBe(400)
  })
  test("forwards read POST bodies and caps caller bodies", async () => {
    const manifest = fixture()
    const read = manifest.operations[0]
    if (!read?.routes?.[0]) throw new Error("missing fixture")
    read.routes[0].method = "POST"
    const { proxy, upstream } = await setup({ maxBodyBytes: 32 }, manifest)
    const send = (body: string) =>
      fetch(proxy.baseUrl, {
        method: "POST",
        headers: {
          "x-eido-connector": "mail",
          "x-eido-target": "https://api.example.com/v1/messages/one",
        },
        body,
      })
    expect((await send("read-query-body")).status).toBe(200)
    const forwarded = upstream.mock.calls[0]?.[1]?.body
    expect(
      forwarded instanceof Uint8Array
        ? new TextDecoder().decode(forwarded)
        : forwarded
    ).toBe("read-query-body")
    expect(await (await send("x".repeat(33))).json()).toEqual({
      reason: "body_limit",
    })
    expect(upstream).toHaveBeenCalledTimes(1)
  })
  test("late vault completion after timeout never contacts upstream", async () => {
    const vault = new InMemoryVault()
    let resolveToken: (token: string) => void = () => {
      throw new Error("vault not called")
    }
    vi.spyOn(vault, "get").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve
        })
    )
    const { request, upstream, db } = await setup({ vault, timeoutMs: 30 })
    expect(await (await request()).json()).toEqual({
      reason: "upstream_timeout",
    })
    resolveToken(TOKEN)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(upstream).not.toHaveBeenCalled()
    expect(audits(db)).toHaveLength(1)
  })
  test("disable during vault read prevents upstream call", async () => {
    const { request, vault, upstream, db } = await setup()
    vi.spyOn(vault, "get").mockImplementation(() => {
      db.prepare("UPDATE connectors SET enabled = 0").run()
      return Promise.resolve(TOKEN)
    })
    expect((await request()).status).toBe(423)
    expect(upstream).not.toHaveBeenCalled()
  })
  test("vault and transport exceptions reveal no secret messages", async () => {
    const { request, vault, upstream } = await setup()
    vi.spyOn(vault, "get").mockRejectedValueOnce(new Error(TOKEN))
    expect(await (await request()).json()).toEqual({
      reason: "upstream_failure",
    })
    upstream.mockRejectedValueOnce(new Error(TOKEN))
    expect(await (await request()).json()).toEqual({
      reason: "upstream_failure",
    })
  })
  test("null upstream body remains empty", async () => {
    const { request, upstream } = await setup()
    upstream.mockResolvedValue(new Response(null, { status: 204 }))
    const response = await request()
    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
  })
  test("reconstructs the pinned destination while escaping path and query components", async () => {
    const { request, upstream } = await setup()
    expect(
      (
        await request(
          "https://api.example.com/v1/messages/a%3Ab?value=https%3A%2F%2Fother.example.com&value=a%26b"
        )
      ).status
    ).toBe(200)
    expect(upstream.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/v1/messages/a%3Ab?value=https%3A%2F%2Fother.example.com&value=a%26b"
    )
  })
  test("invalid limits cannot start a listener", async () => {
    const db = openControlDb(":memory:")
    try {
      await expect(
        startEgressProxy({ db, vault: new InMemoryVault(), maxBodyBytes: 0 })
      ).rejects.toThrow("invalid egress limits")
    } finally {
      db.close()
    }
  })
  test("deadline bounds revoked-grant vault cleanup", async () => {
    const { request, upstream, vault, db } = await setup({ timeoutMs: 30 })
    upstream.mockResolvedValue(new Response(null, { status: 401 }))
    vi.spyOn(vault, "delete").mockImplementation(() => new Promise(() => {}))
    expect(await (await request()).json()).toEqual({
      reason: "upstream_timeout",
    })
    expect(
      db.prepare("SELECT enabled FROM connectors WHERE name = 'mail'").get()?.[
        "enabled"
      ]
    ).toBe(0)
    expect(audits(db)).toHaveLength(1)
  })
})
