import { validateConnectorManifest } from "@eido/schemas"
import { describe, expect, it } from "vitest"
import {
  SIMPLEFIN_ACCOUNTS_PATH,
  SIMPLEFIN_PATH_PREFIX,
  simplefinManifest,
} from "./manifest"
import {
  DEFAULT_DAILY_REQUEST_LIMIT,
  SIMPLEFIN_CONNECTOR,
  SIMPLEFIN_HOST,
  SIMPLEFIN_SOURCE,
} from "./config"

describe("simplefinManifest", () => {
  it("validates against the connector manifest schema", () => {
    const manifest = simplefinManifest()
    const check = validateConnectorManifest(manifest)
    expect(check.ok).toBe(true)
  })

  it("declares only effect: read operations and no write verbs", () => {
    const manifest = simplefinManifest()
    expect(manifest.operations.length).toBeGreaterThan(0)
    for (const op of manifest.operations) {
      expect(op.effect).toBe("read")
      expect(op.intentKind).toBeUndefined()
      expect(op.sensitivity).toBe("high")
      expect(op.untrustedOutput).toBe(true)
      expect(op.defaultTier).toBe("auto")
      expect(op.reversibility).toBe("reversible")
      expect(op.name).not.toMatch(/write|transfer|pay|send|delete|update|move/i)
    }
    const opNames = manifest.operations.map((op) => op.name)
    expect(opNames).toEqual(["listAccounts", "listTransactions"])
  })

  it("restricts egress to bridge.simplefin.org with GET only", () => {
    const manifest = simplefinManifest()
    expect(manifest.name).toBe(SIMPLEFIN_CONNECTOR)
    expect(manifest.auth).toEqual({ type: "basic-url", scopes: [] })
    expect(manifest.egress.hosts).toEqual([
      {
        host: SIMPLEFIN_HOST,
        methods: ["GET"],
        pathPrefixes: [SIMPLEFIN_PATH_PREFIX],
      },
    ])
    for (const op of manifest.operations) {
      for (const route of op.routes ?? []) {
        expect(route.host).toBe(SIMPLEFIN_HOST)
        expect(route.method).toBe("GET")
        expect(route.pathPattern).toBe(SIMPLEFIN_ACCOUNTS_PATH)
      }
    }
  })

  it("configures health backoff, breaker and daily rate limit", () => {
    const manifest = simplefinManifest({ dailyRequestLimit: 10 })
    expect(manifest.health.rateLimit).toEqual({
      requestsPerWindow: 10,
      windowSeconds: 86400,
    })
    expect(manifest.health.breaker).toEqual({
      failureThreshold: 3,
      halfOpenProbeAfterMs: 60_000,
    })

    const defaultManifest = simplefinManifest()
    expect(defaultManifest.health.rateLimit?.requestsPerWindow).toBe(
      DEFAULT_DAILY_REQUEST_LIMIT
    )
  })

  it("declares correct triggers and ledger mapping", () => {
    const manifest = simplefinManifest()
    expect(manifest.triggers).toEqual([
      { kind: "poll", stream: "transactions", intervalSeconds: 86400 },
    ])
    expect(manifest.ledgerMapping).toEqual({
      source: SIMPLEFIN_SOURCE,
      refField: "id",
    })
  })
})
