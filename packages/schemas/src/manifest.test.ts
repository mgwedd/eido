import { describe, expect, test } from "vitest"
import type { ConnectorManifest } from "./index"
import { validateConnectorManifest } from "./index"

// Synthetic connector: example.com hosts, made-up scopes, no real client ids or tokens.
function fixture(): ConnectorManifest {
  return {
    name: "example-mail",
    version: 1,
    description: "Example mail connector for tests",
    auth: {
      type: "oauth2",
      scopes: ["mail.read", "mail.compose"],
    },
    egress: {
      hosts: [
        {
          host: "api.example.com",
          methods: ["GET", "POST"],
          pathPrefixes: ["/v1/messages", "/v1/drafts"],
        },
      ],
    },
    operations: [
      {
        name: "list_messages",
        effect: "read",
        reversibility: "reversible",
        sensitivity: "normal",
        untrustedOutput: true,
        authScopes: ["mail.read"],
        defaultTier: "auto",
      },
      {
        name: "create_draft",
        effect: "write",
        reversibility: "reversible",
        sensitivity: "normal",
        untrustedOutput: false,
        authScopes: ["mail.compose"],
        intentKind: "email.draft",
        defaultTier: "auto",
      },
      {
        name: "send_message",
        effect: "write",
        reversibility: "irreversible",
        sensitivity: "sensitive",
        untrustedOutput: false,
        authScopes: ["mail.compose"],
        intentKind: "email.send",
        defaultTier: "approval",
      },
    ],
    triggers: [{ kind: "poll", stream: "inbox", intervalSeconds: 300 }],
    ledgerMapping: { source: "email", refField: "messageId" },
    health: {
      backoff: { baseMs: 500, maxMs: 60000, jitter: true },
      breaker: { failureThreshold: 3, halfOpenProbeAfterMs: 30000 },
    },
  }
}

function opAt(m: ConnectorManifest, index: number) {
  const op = m.operations[index]
  if (op === undefined) throw new Error(`fixture has no operation ${index}`)
  return op
}

function hostAt(m: ConnectorManifest, index: number) {
  const entry = m.egress.hosts[index]
  if (entry === undefined) throw new Error(`fixture has no host ${index}`)
  return entry
}

function errorsOf(mutate: (m: ConnectorManifest) => void): string[] {
  const manifest = fixture()
  mutate(manifest)
  const result = validateConnectorManifest(manifest)
  return result.ok ? [] : result.errors
}

describe("validateConnectorManifest", () => {
  test("accepts the fixture and returns it", () => {
    const manifest = fixture()
    expect(validateConnectorManifest(manifest)).toEqual({
      ok: true,
      value: fixture(),
    })
  })

  test("rejects an unknown key", () => {
    expect(
      errorsOf((m) => Object.assign(m.auth, { clientSecret: "x" }))
    ).toEqual(["$.auth.clientSecret: unknown key"])
  })

  test.each([
    ["a leading wildcard", "*.example.com"],
    ["a bare wildcard", "*"],
    ["a port", "api.example.com:443"],
    ["a scheme", "https://api.example.com"],
    ["uppercase", "API.example.com"],
    ["a trailing dot", "api.example.com."],
  ])("rejects a host with %s", (_label, host) => {
    expect(
      errorsOf((m) => {
        hostAt(m, 0).host = host
      })
    ).toEqual(["$.egress.hosts[0].host: must be an exact lowercase host name"])
  })

  test("rejects a write operation without intentKind", () => {
    expect(
      errorsOf((m) => {
        delete opAt(m, 1).intentKind
      })
    ).toEqual(["$.operations[1].intentKind: required for a write operation"])
  })

  test("rejects an irreversible operation defaulting to auto", () => {
    expect(
      errorsOf((m) => {
        opAt(m, 2).defaultTier = "auto"
      })
    ).toEqual([
      "$.operations[2].defaultTier: an irreversible operation cannot default to auto",
    ])
  })

  test("rejects a breaker failureThreshold below 1", () => {
    expect(
      errorsOf((m) => {
        m.health.breaker.failureThreshold = 0
      })
    ).toEqual(["$.health.breaker.failureThreshold: must be at least 1"])
  })

  test("rejects a connector name that is not an id", () => {
    expect(
      errorsOf((m) => {
        m.name = "Example Mail"
      })
    ).toEqual([
      "$.name: must start with a lowercase letter and use only a-z, 0-9 and -",
    ])
  })

  test("rejects a read operation that names an intent", () => {
    expect(
      errorsOf((m) => {
        opAt(m, 0).intentKind = "email.draft"
      })
    ).toEqual([
      "$.operations[0].intentKind: only write operations name an intent",
    ])
  })

  test("rejects an intentKind that is not an intent verb", () => {
    expect(
      errorsOf((m) => {
        opAt(m, 1).intentKind = "email.purge"
      })
    ).toEqual(["$.operations[1].intentKind: unknown intent kind"])
  })

  test("rejects an operation scope missing from auth.scopes", () => {
    expect(
      errorsOf((m) => {
        opAt(m, 0).authScopes = ["mail.admin"]
      })
    ).toEqual([
      '$.operations[0].authScopes: "mail.admin" is not in auth.scopes',
    ])
  })

  test("rejects duplicate operation names", () => {
    expect(
      errorsOf((m) => {
        opAt(m, 1).name = "list_messages"
      })
    ).toEqual(['$.operations: duplicate operation "list_messages"'])
  })

  test("rejects duplicate scopes, hosts and methods", () => {
    expect(
      errorsOf((m) => {
        m.auth.scopes.push("mail.read")
        m.egress.hosts.push({
          host: "api.example.com",
          methods: ["GET", "GET"],
          pathPrefixes: ["/v2"],
        })
      })
    ).toEqual([
      '$.auth.scopes: duplicate scope "mail.read"',
      "$.egress.hosts[1].methods: duplicate method GET",
      "$.egress.hosts: duplicate host api.example.com",
    ])
  })

  test.each([["v1/messages"], ["/v1/*"]])(
    "rejects the path prefix %s",
    (prefix) => {
      expect(
        errorsOf((m) => {
          hostAt(m, 0).pathPrefixes = [prefix]
        })
      ).toEqual([
        "$.egress.hosts[0].pathPrefixes[0]: must start with / and contain no wildcard",
      ])
    }
  )

  test("rejects a backoff maxMs below baseMs", () => {
    expect(
      errorsOf((m) => {
        m.health.backoff.maxMs = 100
      })
    ).toEqual(["$.health.backoff.maxMs: must be at least baseMs"])
  })

  test("rejects a version that is not an integer", () => {
    expect(
      errorsOf((m) => {
        m.version = 1.5
      })
    ).toEqual(["$.version: expected integer, got number"])
  })
})
