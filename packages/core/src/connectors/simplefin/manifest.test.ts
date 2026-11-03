import { validateConnectorManifest } from "@eido/schemas"
import { describe, expect, it } from "vitest"
import { simplefinManifest } from "./manifest"

describe("simplefinManifest", () => {
  it("is a valid manifest", () => {
    expect(validateConnectorManifest(simplefinManifest()).ok).toBe(true)
  })

  it("declares only read operations, on GET routes to Bridge", () => {
    const manifest = simplefinManifest()
    expect(
      manifest.operations.map(
        ({ name, effect, sensitivity, untrustedOutput, routes }) => ({
          name,
          effect,
          sensitivity,
          untrustedOutput,
          routes,
        })
      )
    ).toEqual(
      ["listAccounts", "listTransactions"].map((name) => ({
        name,
        effect: "read",
        sensitivity: "high",
        untrustedOutput: true,
        routes: [
          {
            host: "bridge.simplefin.org",
            method: "GET",
            pathPattern: "/simplefin/accounts",
          },
        ],
      }))
    )
    expect(manifest.auth).toEqual({ type: "basic-url", scopes: [] })
    expect(manifest.egress.hosts).toEqual([
      {
        host: "bridge.simplefin.org",
        methods: ["GET"],
        pathPrefixes: ["/simplefin"],
      },
    ])
  })

  it("sets the daily request budget from configuration, 24 by default", () => {
    expect(simplefinManifest().health.rateLimit).toEqual({ requestsPerDay: 24 })
    expect(
      simplefinManifest({ dailyRequestLimit: 3 }).health.rateLimit
    ).toEqual({ requestsPerDay: 3 })
    expect(() => simplefinManifest({ dailyRequestLimit: 0 })).toThrow(
      "dailyRequestLimit must be an integer from 1 to 100000"
    )
  })
})
