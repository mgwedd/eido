import { afterEach, describe, expect, test, vi } from "vitest"
import type { ConnectorManifest } from "@eido/schemas"
import { egressProbe, startEgressProxy } from "./egress"
import { GOOGLE_TOKEN_URL } from "./oauth-refresh"
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
    // The refused access token is dropped; the revocation cleanup after it never finishes.
    const remove = vault.delete.bind(vault)
    vi.spyOn(vault, "delete")
      .mockImplementationOnce(remove)
      .mockImplementation(() => new Promise(() => {}))
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

const REFRESH = "synthetic-read-refresh-secret"
const CLIENT_SECRET = "synthetic-read-client-secret"
const FRESH = "synthetic-fresh-access-secret"
const READ = { connector: "mail", client: "read" } as const

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  input instanceof Request ? input.url : input.toString()

/** A fake Google token endpoint in front of a fake API that accepts only `accepted` tokens. */
function fakeGoogle(
  accepted: string,
  token: () => Response = () => Response.json({ access_token: FRESH })
) {
  return vi.fn<typeof fetch>((input, init) => {
    if (urlOf(input) === GOOGLE_TOKEN_URL) return Promise.resolve(token())
    const authorization = new Headers(init?.headers).get("authorization")
    return Promise.resolve(
      authorization === `Bearer ${accepted}`
        ? new Response("message-content", {
            headers: { "content-type": "text/plain" },
          })
        : new Response(null, { status: 401 })
    )
  })
}

async function refreshable(
  fake: ReturnType<typeof fakeGoogle>,
  overrides: Partial<Parameters<typeof startEgressProxy>[0]> = {}
) {
  const context = await setup({
    fetch: fake,
    clientIds: { mail: "synthetic-client-id" },
    ...overrides,
  })
  await context.vault.set({ ...READ, kind: "refresh_token" }, REFRESH)
  await context.vault.set({ ...READ, kind: "api_key" }, CLIENT_SECRET)
  return context
}

const tokenCalls = (fake: ReturnType<typeof fakeGoogle>) =>
  fake.mock.calls.filter(([input]) => urlOf(input) === GOOGLE_TOKEN_URL)

function auditText(db: ReturnType<typeof openControlDb>): string {
  return JSON.stringify(db.prepare("SELECT * FROM audit_log").all())
}

describe("read-client token refresh", () => {
  test("an expired access token is refreshed once and the read retried", async () => {
    const fake = fakeGoogle(FRESH)
    const { request, vault, db } = await refreshable(fake)
    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("message-content")
    const calls = tokenCalls(fake)
    expect(calls).toHaveLength(1)
    expect(
      Object.fromEntries(
        calls[0]?.[1]?.body instanceof URLSearchParams ? calls[0][1].body : []
      )
    ).toEqual({
      client_id: "synthetic-client-id",
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH,
      grant_type: "refresh_token",
    })
    const reads = fake.mock.calls
      .filter(([input]) => urlOf(input) !== GOOGLE_TOKEN_URL)
      .map(([, init]) => new Headers(init?.headers).get("authorization"))
    expect(reads).toEqual([`Bearer ${TOKEN}`, `Bearer ${FRESH}`])
    expect(await vault.get({ ...READ, kind: "access_token" })).toBe(FRESH)
    expect(
      db
        .prepare("SELECT enabled, health FROM connectors WHERE name = 'mail'")
        .get()
    ).toEqual({ enabled: 1, health: "healthy" })
  })

  test("refreshes from shared Google client secret when specific key is not set", async () => {
    const fake = fakeGoogle(FRESH)
    const context = await refreshable(fake)
    await context.vault.delete({ ...READ, kind: "api_key" })
    await context.vault.delete({ ...READ, kind: "access_token" })
    await context.vault.set(
      { connector: "google", kind: "api_key", client: "none" },
      CLIENT_SECRET
    )
    const response = await context.request()
    expect(response.status).toBe(200)
    expect(tokenCalls(fake).length).toBe(1)
  })

  test("a missing access token is fetched from the refresh token before the read", async () => {
    const fake = fakeGoogle(FRESH)
    const { request, vault } = await refreshable(fake)
    await vault.delete({ ...READ, kind: "access_token" })
    expect((await request()).status).toBe(200)
    expect(tokenCalls(fake)).toHaveLength(1)
    expect(fake).toHaveBeenCalledTimes(2)
  })

  test("invalid_grant disables the connector with auth_failed and audits a hash only", async () => {
    const fake = fakeGoogle(FRESH, () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })
    )
    const { request, vault, db } = await refreshable(fake)
    const response = await request()
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ reason: "grant_revoked" })
    expect(tokenCalls(fake)).toHaveLength(1)
    expect(fake).toHaveBeenCalledTimes(2)
    expect(
      db
        .prepare(
          "SELECT enabled, health, last_error FROM connectors WHERE name = 'mail'"
        )
        .get()
    ).toEqual({ enabled: 0, health: "open", last_error: "auth_failed" })
    expect(
      db
        .prepare(
          "SELECT actor, target, detail_hash FROM audit_log WHERE action = 'grant_revoked'"
        )
        .all()
    ).toEqual([
      {
        actor: "system",
        target: "mail",
        detail_hash: payloadHash({ errorClass: "invalid_grant" }),
      },
    ])
    expect(await vault.get({ ...READ, kind: "access_token" })).toBeUndefined()
    // Re-authorization replaces the refresh token; revocation leaves it in place.
    expect(await vault.get({ ...READ, kind: "refresh_token" })).toBe(REFRESH)
    expect((await request()).status).toBe(423)
    expect(fake).toHaveBeenCalledTimes(2)
  })

  test("an access token refused again after a refresh revokes the grant", async () => {
    const fake = fakeGoogle("synthetic-never-accepted")
    const { request, db } = await refreshable(fake)
    expect(await (await request()).json()).toEqual({ reason: "grant_revoked" })
    expect(tokenCalls(fake)).toHaveLength(1)
    expect(fake).toHaveBeenCalledTimes(3)
    expect(
      db
        .prepare(
          "SELECT detail_hash FROM audit_log WHERE action = 'grant_revoked'"
        )
        .get()?.["detail_hash"]
    ).toBe(payloadHash({ errorClass: "unauthorized" }))
  })

  test.each([
    ["the token endpoint fails", () => new Response("down", { status: 503 })],
    ["the answer has no access token", () => Response.json({})],
  ])(
    "a temporary refresh failure when %s keeps the connector enabled",
    async (_, token) => {
      const fake = fakeGoogle(FRESH, token)
      const { request, db } = await refreshable(fake)
      expect(await (await request()).json()).toEqual({
        reason: "token_refresh_failed",
      })
      expect(
        db
          .prepare("SELECT enabled FROM connectors WHERE name = 'mail'")
          .get()?.["enabled"]
      ).toBe(1)
    }
  )

  test("a read client with no stored grant answers credential_missing and stays enabled", async () => {
    const fake = fakeGoogle(FRESH)
    const { request, vault, db } = await refreshable(fake)
    await vault.delete({ ...READ, kind: "access_token" })
    await vault.delete({ ...READ, kind: "refresh_token" })
    const response = await request()
    expect(response.status).toBe(424)
    expect(await response.json()).toEqual({ reason: "credential_missing" })
    expect(fake).not.toHaveBeenCalled()
    expect(
      db.prepare("SELECT enabled FROM connectors WHERE name = 'mail'").get()?.[
        "enabled"
      ]
    ).toBe(1)
  })

  test("a connector without a configured client id is not refreshed", async () => {
    const fake = fakeGoogle(FRESH)
    const { request } = await refreshable(fake, { clientIds: {} })
    expect(await (await request()).json()).toEqual({
      reason: "token_refresh_failed",
    })
    expect(tokenCalls(fake)).toHaveLength(0)
  })

  test("no token or client secret reaches the audit log or an error body", async () => {
    const secrets = [TOKEN, REFRESH, CLIENT_SECRET, FRESH]
    const bodies: string[] = []
    const ok = await refreshable(fakeGoogle(FRESH))
    bodies.push(await (await ok.request()).text())
    const revoked = await refreshable(
      fakeGoogle(FRESH, () =>
        Response.json({ error: "invalid_grant" }, { status: 400 })
      )
    )
    bodies.push(
      await (await revoked.request()).text(),
      await (await revoked.request()).text()
    )
    const failing = await refreshable(
      fakeGoogle(
        FRESH,
        () => new Response(`echo ${REFRESH} ${CLIENT_SECRET}`, { status: 500 })
      )
    )
    bodies.push(await (await failing.request()).text())
    const text = [
      ...bodies,
      auditText(ok.db),
      auditText(revoked.db),
      auditText(failing.db),
    ].join("\n")
    expect(bodies).toEqual([
      "message-content",
      JSON.stringify({ reason: "grant_revoked" }),
      JSON.stringify({ reason: "connector_disabled" }),
      JSON.stringify({ reason: "token_refresh_failed" }),
    ])
    for (const secret of secrets) expect(text).not.toContain(secret)
  })
})

describe("read connector health probe", () => {
  async function probeFor(
    fake: ReturnType<typeof fakeGoogle>,
    url = "https://api.example.com/v1/messages/probe"
  ) {
    const context = await refreshable(fake)
    return {
      ...context,
      probe: egressProbe(
        {
          db: context.db,
          vault: context.vault,
          fetch: fake,
          clientIds: { mail: "synthetic-client-id" },
        },
        "mail",
        url
      ),
    }
  }

  test("reports ok after refreshing an expired token", async () => {
    const fake = fakeGoogle(FRESH)
    const { probe, vault } = await probeFor(fake)
    expect(await probe()).toBe("ok")
    expect(tokenCalls(fake)).toHaveLength(1)
    expect(await vault.get({ ...READ, kind: "access_token" })).toBe(FRESH)
  })

  test("reports auth_failed for a revoked grant", async () => {
    const { probe } = await probeFor(
      fakeGoogle(FRESH, () =>
        Response.json({ error: "invalid_grant" }, { status: 400 })
      )
    )
    expect(await probe()).toBe("auth_failed")
  })

  test("reports unavailable for an upstream error and for an unpinned route", async () => {
    const failing = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }))
    const { probe } = await probeFor(failing)
    expect(await probe()).toBe("unavailable")
    const unpinned = fakeGoogle(TOKEN)
    const other = await probeFor(unpinned, "https://api.example.com/v1/secrets")
    expect(await other.probe()).toBe("unavailable")
    expect(unpinned).not.toHaveBeenCalled()
  })

  test("reports timeout when the read outlasts its deadline", async () => {
    const context = await refreshable(fakeGoogle(TOKEN))
    const hanging = vi.fn<typeof fetch>(
      (_, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          )
        })
    )
    const probe = egressProbe(
      { db: context.db, vault: context.vault, fetch: hanging, timeoutMs: 20 },
      "mail",
      "https://api.example.com/v1/messages/probe"
    )
    expect(await probe()).toBe("timeout")
  })
})
