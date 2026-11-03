import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest"
import type { ConnectorManifest } from "@eido/schemas"
import { egressProbe, startEgressProxy } from "./egress"
import { openControlDb } from "./control-db"
import { getConnectorHealth } from "./connector-health"
import { localDay, nextLocalMidnight } from "./connector-quota"
import { signedPin } from "./test-fixtures"
import { InMemoryVault } from "./vault/vault"

// The proxy's `auth: basic-url` path (SimpleFIN, #51) against a stub Bridge: the access URL from
// the vault becomes a Basic header, a daily request budget is enforced locally, and a refused
// credential disables the connector once. The access URL below is invented.

beforeAll(() => {
  // Local-day arithmetic is checked against hand-written literals for this zone.
  vi.stubEnv("TZ", "America/New_York")
})
afterAll(() => {
  vi.unstubAllEnvs()
})

const HOST = "bridge.simplefin.org"
/** A password whose percent-escape does not decode. */
const MALFORMED_ESCAPE = "%E0%A4%A"
const PASSWORD = "synthetic-pass-9f3"
const ACCESS_URL = `https://synthetic-user:${PASSWORD}@bridge.simplefin.org/simplefin`
const BASIC = `Basic ${Buffer.from("synthetic-user:synthetic-pass-9f3").toString("base64")}`
const ACCOUNTS = `https://${HOST}/simplefin/accounts?start-date=1700000000`
const ACCESS_KEY = {
  connector: "simplefin",
  kind: "api_key",
  client: "read",
} as const
// 2026-03-10 15:00 in New York (UTC-4 after the DST change on 2026-03-08).
const NOON_ISH = Date.parse("2026-03-10T19:00:00.000Z")

function manifest(requestsPerDay = 3): ConnectorManifest {
  return {
    name: "simplefin",
    version: 1,
    description: "Synthetic bank reads",
    auth: { type: "basic-url", scopes: [] },
    egress: {
      hosts: [{ host: HOST, methods: ["GET"], pathPrefixes: ["/simplefin"] }],
    },
    operations: [
      {
        name: "listAccounts",
        effect: "read",
        reversibility: "reversible",
        sensitivity: "high",
        untrustedOutput: true,
        authScopes: [],
        defaultTier: "auto",
        routes: [
          { host: HOST, method: "GET", pathPattern: "/simplefin/accounts" },
        ],
      },
    ],
    triggers: [],
    ledgerMapping: { source: "simplefin", refField: "id" },
    health: {
      backoff: { baseMs: 1, maxMs: 2, jitter: false },
      breaker: { failureThreshold: 3, halfOpenProbeAfterMs: 10 },
      rateLimit: { requestsPerDay },
    },
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup(
  options: {
    requestsPerDay?: number
    accessUrl?: string | undefined
    respond?: () => Response
    now?: () => number
  } = {}
) {
  const db = openControlDb(":memory:")
  signedPin(db, manifest(options.requestsPerDay))
  const vault = new InMemoryVault()
  const accessUrl = "accessUrl" in options ? options.accessUrl : ACCESS_URL
  if (accessUrl !== undefined) await vault.set(ACCESS_KEY, accessUrl)
  const upstream = vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(
      options.respond?.() ??
        new Response('{"errors":[],"accounts":[]}', {
          headers: { "content-type": "application/json" },
        })
    )
  )
  let clock = NOON_ISH
  const now = options.now ?? (() => clock)
  const proxy = await startEgressProxy({ db, vault, fetch: upstream, now })
  cleanups.push(async () => {
    await proxy.close()
    db.close()
  })
  const request = (target = ACCOUNTS, method = "GET") =>
    fetch(proxy.baseUrl, {
      method,
      headers: { "x-eido-connector": "simplefin", "x-eido-target": target },
    })
  const health = () =>
    getConnectorHealth(db, now()).find((row) => row.name === "simplefin")
  return {
    db,
    vault,
    upstream,
    request,
    health,
    setClock: (at: number) => {
      clock = at
    },
  }
}

function sentHeaders(upstream: ReturnType<typeof vi.fn<typeof fetch>>) {
  const init = upstream.mock.calls[0]?.[1]
  return new Headers(init?.headers)
}

describe("basic-url egress (SimpleFIN)", () => {
  test("sends the vault's access URL as a Basic header to the pinned host only", async () => {
    const { request, upstream } = await setup()
    const response = await request()
    expect(response.status).toBe(200)
    expect(upstream.mock.calls[0]?.[0]).toBe(ACCOUNTS)
    expect(sentHeaders(upstream).get("authorization")).toBe(BASIC)
  })

  test("refuses a host, method or path outside the manifest before sending", async () => {
    const { request, upstream } = await setup()
    expect(
      (await request("https://beta-bridge.simplefin.org/simplefin/accounts"))
        .status
    ).toBe(403)
    expect((await request(ACCOUNTS, "POST")).status).toBe(405)
    expect((await request(`https://${HOST}/simplefin/claim/abc`)).status).toBe(
      406
    )
    expect(upstream).not.toHaveBeenCalled()
  })

  test("refuses without a stored access URL, or with one for another host or path", async () => {
    for (const accessUrl of [
      undefined,
      "https://user:pass@other.example.invalid/simplefin",
      "https://user:pass@bridge.simplefin.org/other",
      "https://bridge.simplefin.org/simplefin",
      "http://user:pass@bridge.simplefin.org/simplefin",
      `https://user:${MALFORMED_ESCAPE}@bridge.simplefin.org/simplefin`,
      "not a url",
    ]) {
      const { request, upstream } = await setup({ accessUrl })
      const response = await request()
      expect(response.status).toBe(424)
      expect(await response.json()).toEqual({
        reason:
          accessUrl === undefined ? "credential_missing" : "credential_invalid",
      })
      expect(upstream).not.toHaveBeenCalled()
    }
  })

  test("refuses request N+1 of the local day without sending it, and health shows the daily limit", async () => {
    const { request, upstream, health, setClock } = await setup({
      requestsPerDay: 2,
    })
    expect(health()).toEqual({
      name: "simplefin",
      health: "healthy",
      consecutiveFailures: 0,
      requestsToday: 0,
      requestLimit: 2,
    })
    expect((await request()).status).toBe(200)
    expect((await request()).status).toBe(200)
    const refused = await request()
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ reason: "daily_limit" })
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(health()).toEqual({
      name: "simplefin",
      health: "degraded",
      consecutiveFailures: 0,
      lastError: "Daily limit",
      requestsToday: 2,
      requestLimit: 2,
      nextSyncAt: "2026-03-11T04:00:00.000Z",
    })
    // Local midnight in New York is 04:00 UTC: one minute before it the budget is still spent.
    setClock(Date.parse("2026-03-11T03:59:00.000Z"))
    expect((await request()).status).toBe(429)
    setClock(Date.parse("2026-03-11T04:00:00.000Z"))
    expect(health()).toEqual({
      name: "simplefin",
      health: "healthy",
      consecutiveFailures: 0,
      requestsToday: 0,
      requestLimit: 2,
    })
    expect((await request()).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(3)
    expect(health()?.requestsToday).toBe(1)
  })

  test("a 401 or 403 disables the connector once, audits it, and sends nothing more", async () => {
    for (const status of [401, 403]) {
      const { db, request, upstream } = await setup({
        respond: () => new Response("denied", { status }),
      })
      const first = await request()
      expect(first.status).toBe(502)
      expect(await first.json()).toEqual({ reason: "grant_revoked" })
      expect((await request()).status).toBe(423)
      expect(upstream).toHaveBeenCalledTimes(1)
      expect(
        db
          .prepare(
            "SELECT enabled, last_error FROM connectors WHERE name = 'simplefin'"
          )
          .get()
      ).toEqual({ enabled: 0, last_error: "auth_failed" })
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'grant_revoked' AND target = 'simplefin'"
          )
          .get()
      ).toEqual({ n: 1 })
    }
  })

  test("refuses a response that echoes the access URL or its password", async () => {
    for (const echo of [ACCESS_URL, PASSWORD, BASIC]) {
      const { request } = await setup({
        respond: () => new Response(`{"note":"${echo}"}`),
      })
      const response = await request()
      expect(response.status).toBe(502)
      const text = await response.text()
      expect(text).toBe('{"reason":"credential_echo"}')
    }
  })

  test("the health probe reads through the same path and reports a refused credential", async () => {
    const ok = await setup()
    const probe = egressProbe(
      { db: ok.db, vault: ok.vault, fetch: ok.upstream },
      "simplefin",
      `https://${HOST}/simplefin/accounts?balances-only=1`
    )
    expect(await probe()).toBe("ok")
    expect(sentHeaders(ok.upstream).get("authorization")).toBe(BASIC)
    const revoked = await setup({
      respond: () => new Response("", { status: 403 }),
    })
    expect(
      await egressProbe(
        { db: revoked.db, vault: revoked.vault, fetch: revoked.upstream },
        "simplefin",
        `https://${HOST}/simplefin/accounts?balances-only=1`
      )()
    ).toBe("auth_failed")
  })
})

describe("local day", () => {
  test("is the gate host's calendar day, and the budget resets at its midnight", () => {
    expect(localDay(Date.parse("2026-03-11T03:59:59.000Z"))).toBe("2026-03-10")
    expect(localDay(Date.parse("2026-03-11T04:00:00.000Z"))).toBe("2026-03-11")
    // Across the DST change the day is 23 hours long.
    expect(
      new Date(
        nextLocalMidnight(Date.parse("2026-03-08T12:00:00.000Z"))
      ).toISOString()
    ).toBe("2026-03-09T04:00:00.000Z")
    expect(
      new Date(
        nextLocalMidnight(Date.parse("2026-03-07T12:00:00.000Z"))
      ).toISOString()
    ).toBe("2026-03-08T05:00:00.000Z")
  })
})
