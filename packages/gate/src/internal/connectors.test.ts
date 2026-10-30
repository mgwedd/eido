import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { ConnectorManifest } from "@eido/schemas"
import { describe, expect, it } from "vitest"
import { append, verifyChain } from "./audit"
import {
  checkDrift,
  egressAllowlist,
  getConnectorState,
  getPinnedManifest,
  intentBindings,
  manifestHash,
  pinnedOperation,
  resolveTier,
} from "./connectors"
import { openControlDb } from "./control-db"
import { signedPin } from "./test-fixtures"

// Synthetic connectors: example.com hosts, made-up scopes, no real client ids or tokens.
function mail(version = 1): ConnectorManifest {
  return {
    name: "example-mail",
    version,
    description: "Example mail connector for tests",
    auth: { type: "oauth2", scopes: ["mail.read", "mail.compose"] },
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

function files(): ConnectorManifest {
  return {
    name: "example-files",
    version: 1,
    description: "Example files connector for tests",
    auth: { type: "api_key", scopes: [] },
    egress: {
      hosts: [
        {
          host: "files.example.com",
          methods: ["GET"],
          pathPrefixes: ["/api/"],
        },
      ],
    },
    operations: [
      {
        name: "list_files",
        effect: "read",
        reversibility: "reversible",
        sensitivity: "normal",
        untrustedOutput: true,
        authScopes: [],
        defaultTier: "auto",
      },
    ],
    triggers: [{ kind: "push", stream: "changes" }],
    ledgerMapping: { source: "file", refField: "fileId" },
    health: {
      backoff: { baseMs: 1000, maxMs: 1000, jitter: false },
      breaker: { failureThreshold: 3, halfOpenProbeAfterMs: 60000 },
    },
  }
}

const PINNED_TOOLS = ["list_messages", "send_message"]

// Independent digest for these synthetic JSON fixtures; never call the hash under test to
// derive an expected value. Their numbers and strings need no RFC 8785 edge-case formatting.
function expectedHash(value: unknown): string {
  function sortedJson(input: unknown): string {
    if (Array.isArray(input)) return `[${input.map(sortedJson).join(",")}]`
    if (input !== null && typeof input === "object") {
      return `{${Object.entries(input)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`)
        .join(",")}}`
    }
    return JSON.stringify(input)
  }
  return createHash("sha256").update(sortedJson(value)).digest("hex")
}

type ConnectorRow = {
  enabled: number
  manifest_hash: string
  drift_json: string | null
  health: string
  consecutive_failures: number
}

function row(db: DatabaseSync, name = "example-mail"): ConnectorRow {
  const raw = db
    .prepare(
      "SELECT enabled, manifest_hash, drift_json, health, consecutive_failures FROM connectors WHERE name = ?"
    )
    .get(name)
  if (raw === undefined) throw new Error(`no row for ${name}`)
  return {
    enabled: Number(raw["enabled"]),
    manifest_hash: String(raw["manifest_hash"]),
    drift_json: raw["drift_json"] === null ? null : String(raw["drift_json"]),
    health: String(raw["health"]),
    consecutive_failures: Number(raw["consecutive_failures"]),
  }
}

function auditRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT actor, action, target, detail_hash FROM audit_log ORDER BY seq"
    )
    .all()
}

function pinned(): DatabaseSync {
  const db = openControlDb(":memory:")
  signedPin(db, mail(), "owner")
  return db
}

describe("pinManifest", () => {
  it("includes each local endpoint port in the pinned manifest hash", () => {
    const manifest = mail()
    manifest.egress.local = [
      { protocol: "imap", host: "127.0.0.1", port: 1143 },
      { protocol: "smtp", host: "127.0.0.1", port: 1025 },
    ]
    const pinnedHash = manifestHash(manifest)
    const changedImap = structuredClone(manifest)
    const imap = changedImap.egress.local?.[0]
    if (imap === undefined)
      throw new Error("manifest has no local IMAP endpoint")
    imap.port = 1144
    expect(manifestHash(changedImap)).not.toBe(pinnedHash)

    const changedSmtp = structuredClone(manifest)
    const smtp = changedSmtp.egress.local?.[1]
    if (smtp === undefined)
      throw new Error("manifest has no local SMTP endpoint")
    smtp.port = 1026
    expect(manifestHash(changedSmtp)).not.toBe(pinnedHash)
  })

  it("stores the manifest enabled and healthy with its hash", () => {
    const db = pinned()
    expect(row(db)).toEqual({
      enabled: 1,
      manifest_hash: expectedHash(mail()),
      drift_json: null,
      health: "healthy",
      consecutive_failures: 0,
    })
    expect(getPinnedManifest(db, "example-mail")).toEqual(mail())
  })

  it("refuses an invalid manifest and stores nothing", () => {
    const db = openControlDb(":memory:")
    const bad = mail()
    delete bad.operations[1]?.intentKind
    expect(() => signedPin(db, bad, "owner")).toThrow(
      "intentKind: required for a write operation"
    )
    expect(getPinnedManifest(db, "example-mail")).toBeUndefined()
    expect(auditRows(db)).toEqual([])
  })

  it("refuses a changed manifest that does not bump the version", () => {
    const db = pinned()
    const changed = { ...mail(), description: "Changed without a bump" }
    expect(() => signedPin(db, changed, "owner")).toThrow(
      "needs a version above 1"
    )
    expect(getPinnedManifest(db, "example-mail")).toEqual(mail())
    expect(auditRows(db)).toHaveLength(1)
  })

  it("refuses a changed manifest with a lower version", () => {
    const db = openControlDb(":memory:")
    signedPin(db, mail(2), "owner")
    const older = { ...mail(1), description: "An older review" }
    expect(() => signedPin(db, older, "owner")).toThrow(
      "needs a version above 2"
    )
    expect(getPinnedManifest(db, "example-mail")).toEqual(mail(2))
  })

  it("refuses to re-enable a drift-disabled connector with the same manifest", () => {
    const db = pinned()
    checkDrift(db, "example-mail", [...PINNED_TOOLS, "delete_message"])
    expect(() => signedPin(db, mail(), "owner")).toThrow(
      "disabled after drift: pin a re-reviewed manifest with a version above 1"
    )
    expect(row(db).enabled).toBe(0)
    expect(row(db).drift_json).toBe('{"added":["delete_message"],"removed":[]}')
    expect(auditRows(db).map((r) => r["action"])).toEqual([
      "connector.pinned",
      "connector.disabled_drift",
    ])
  })

  it("keeps an identical re-pin enabled with the same hash", () => {
    const db = pinned()
    const before = row(db).manifest_hash
    signedPin(db, mail(), "owner")
    expect(row(db).enabled).toBe(1)
    expect(row(db).manifest_hash).toBe(before)
    expect(auditRows(db).map((r) => r["action"])).toEqual([
      "connector.pinned",
      "connector.pinned",
    ])
  })

  it("allows a signed same-version re-pin of a migration-disabled unsigned connector", () => {
    const db = openControlDb(":memory:")
    const original = mail()
    const hash = expectedHash(original)
    db.prepare(
      "INSERT INTO connectors (name, manifest_json, manifest_hash, pinned_at, enabled, health, consecutive_failures) VALUES (?, ?, ?, ?, 0, 'healthy', 0)"
    ).run(
      original.name,
      JSON.stringify(original),
      hash,
      new Date().toISOString()
    )
    expect(() => getConnectorState(db, original.name)).toThrow("pin audit")
    append(db, {
      actor: "system",
      action: "connector.disabled_unsigned",
      target: original.name,
      detailHash: expectedHash({ manifestHash: hash }),
    })

    expect(getPinnedManifest(db, original.name)).toBeUndefined()
    expect(getConnectorState(db, original.name)).toEqual({
      manifest: original,
      enabled: false,
      drift: null,
    })
    signedPin(db, original, "owner")
    expect(getPinnedManifest(db, original.name)).toEqual(original)
    expect(verifyChain(db)).toEqual({ ok: true, rows: 2 })
  })

  it("resets health and failures on a re-pin", () => {
    const db = pinned()
    db.exec(
      "UPDATE connectors SET health = 'open', consecutive_failures = 3 WHERE name = 'example-mail'"
    )
    signedPin(db, mail(2), "owner")
    expect(row(db).health).toBe("healthy")
    expect(row(db).consecutive_failures).toBe(0)
  })
})

describe("checkDrift", () => {
  it("leaves the connector enabled for an identical tool list in any order", () => {
    const db = pinned()
    expect(
      checkDrift(db, "example-mail", ["send_message", "list_messages"])
    ).toEqual({
      drifted: false,
      enabled: true,
      added: [],
      removed: [],
    })
    expect(row(db).enabled).toBe(1)
    expect(auditRows(db)).toHaveLength(1)
  })

  it("invariant: manifest tool drift disables the connector until re-reviewed", () => {
    const db = pinned()
    expect(
      checkDrift(db, "example-mail", [...PINNED_TOOLS, "delete_message"])
    ).toEqual({
      drifted: true,
      enabled: false,
      added: ["delete_message"],
      removed: [],
    })
    expect(row(db).enabled).toBe(0)
    expect(row(db).drift_json).toBe('{"added":["delete_message"],"removed":[]}')
  })

  it("disables the connector when the server drops a tool", () => {
    const db = pinned()
    expect(checkDrift(db, "example-mail", ["list_messages"])).toEqual({
      drifted: true,
      enabled: false,
      added: [],
      removed: ["send_message"],
    })
    expect(row(db).enabled).toBe(0)
  })

  it("throws for a connector that was never pinned", () => {
    const db = openControlDb(":memory:")
    expect(() => checkDrift(db, "example-mail", [])).toThrow("not pinned")
  })

  it("keeps a disabled connector disabled until a new manifest is pinned", () => {
    const db = pinned()
    const firstHash = row(db).manifest_hash
    checkDrift(db, "example-mail", [...PINNED_TOOLS, "delete_message"])

    // Reporting the original tools again does not re-enable it.
    expect(checkDrift(db, "example-mail", PINNED_TOOLS)).toEqual({
      drifted: false,
      enabled: false,
      added: [],
      removed: [],
    })
    expect(row(db).enabled).toBe(0)
    expect(pinnedOperation(db, "example-mail", "list_messages")).toBeUndefined()
    expect(intentBindings(db, "email.send")).toEqual([])
    expect(getPinnedManifest(db, "example-mail")).toBeUndefined()
    expect(getConnectorState(db, "example-mail")).toEqual({
      manifest: mail(),
      enabled: false,
      drift: { added: ["delete_message"], removed: [] },
    })

    // Distinct drift while disabled updates the record and is auditable once.
    expect(checkDrift(db, "example-mail", ["list_messages"]).enabled).toBe(
      false
    )
    expect(row(db).drift_json).toBe('{"added":[],"removed":["send_message"]}')
    expect(auditRows(db).map((r) => r["action"])).toEqual([
      "connector.pinned",
      "connector.disabled_drift",
      "connector.drift_changed",
    ])
    checkDrift(db, "example-mail", ["list_messages"])
    expect(auditRows(db)).toHaveLength(3)
    expect(verifyChain(db)).toEqual({ ok: true, rows: 3 })
    expect(auditRows(db)[2]?.["detail_hash"]).toBe(
      expectedHash({
        manifestHash: expectedHash(mail()),
        added: [],
        removed: ["send_message"],
      })
    )

    const reviewed = mail(2)
    reviewed.operations.push({
      name: "delete_message",
      effect: "write",
      reversibility: "reversible",
      sensitivity: "normal",
      untrustedOutput: false,
      authScopes: ["mail.compose"],
      intentKind: "email.trash",
      defaultTier: "approval",
    })
    signedPin(db, reviewed, "owner")
    expect(row(db).enabled).toBe(1)
    expect(row(db).drift_json).toBeNull()
    expect(row(db).manifest_hash).not.toBe(firstHash)
    expect(row(db).manifest_hash).toBe(expectedHash(reviewed))
    expect(getPinnedManifest(db, "example-mail")).toEqual(reviewed)
  })
})

describe("policy reads the pinned manifest only", () => {
  it("ignores what the server reports about its tools", () => {
    const db = pinned()
    // A server listing whose annotations claim the send tool is read-only and harmless.
    const reported = [
      { name: "list_messages", annotations: { readOnlyHint: true } },
      {
        name: "send_message",
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    ]
    checkDrift(
      db,
      "example-mail",
      reported.map((tool) => tool.name)
    )
    expect(getPinnedManifest(db, "example-mail")).toEqual(mail())
    expect(pinnedOperation(db, "example-mail", "send_message")).toMatchObject({
      effect: "write",
      reversibility: "irreversible",
      defaultTier: "approval",
    })

    checkDrift(db, "example-mail", [...PINNED_TOOLS, "export_all"])
    expect(getPinnedManifest(db, "example-mail")).toBeUndefined()
    expect(getConnectorState(db, "example-mail")?.manifest).toEqual(mail())
  })

  it("has no tier for an operation absent from the manifest", () => {
    const db = pinned()
    expect(pinnedOperation(db, "example-mail", "export_all")).toBeUndefined()
    expect(
      pinnedOperation(db, "example-other", "list_messages")
    ).toBeUndefined()
  })

  it("refuses a stored manifest that was edited outside pinManifest", () => {
    const db = pinned()
    const edited = JSON.stringify({ ...mail(), description: "Edited in place" })
    db.prepare("UPDATE connectors SET manifest_json = ? WHERE name = ?").run(
      edited,
      "example-mail"
    )
    expect(() => getPinnedManifest(db, "example-mail")).toThrow(
      "does not match its hash"
    )
  })

  it("refuses a stored manifest that no longer validates", () => {
    const db = pinned()
    db.prepare("UPDATE connectors SET manifest_json = ? WHERE name = ?").run(
      JSON.stringify({ ...mail(), extra: true }),
      "example-mail"
    )
    expect(() => getPinnedManifest(db, "example-mail")).toThrow(
      "stored connector manifest is invalid: $.extra: unknown key"
    )
  })

  it("refuses a consistent manifest and hash edit without a matching pin audit", () => {
    const db = pinned()
    const changed = { ...mail(), description: "Edited in place" }
    db.prepare(
      "UPDATE connectors SET manifest_json = ?, manifest_hash = ? WHERE name = ?"
    ).run(JSON.stringify(changed), expectedHash(changed), "example-mail")
    expect(() => getPinnedManifest(db, "example-mail")).toThrow(
      "does not match its pin audit"
    )
    expect(() => pinnedOperation(db, "example-mail", "list_messages")).toThrow(
      "does not match its pin audit"
    )
    expect(() => intentBindings(db, "email.send")).toThrow(
      "does not match its pin audit"
    )
    expect(() => egressAllowlist(db)).toThrow("does not match its pin audit")
  })
})

describe("resolveTier", () => {
  it("lets config tighten the manifest default", () => {
    expect(resolveTier("auto", "approval")).toBe("approval")
  })

  it("lets config loosen the manifest default", () => {
    expect(resolveTier("approval", "auto")).toBe("auto")
  })

  it("falls back to the manifest default without config", () => {
    expect(resolveTier("approval", undefined)).toBe("approval")
  })
})

describe("egressAllowlist", () => {
  it("lists hosts, methods and path prefixes of enabled connectors only", () => {
    const db = pinned()
    signedPin(db, files(), "owner")
    const both = [
      {
        connector: "example-files",
        host: "files.example.com",
        methods: ["GET"],
        pathPrefixes: ["/api/"],
      },
      {
        connector: "example-mail",
        host: "api.example.com",
        methods: ["GET", "POST"],
        pathPrefixes: ["/v1/messages", "/v1/drafts"],
      },
    ]
    expect(egressAllowlist(db)).toEqual(both)

    checkDrift(db, "example-mail", ["list_messages"])
    expect(egressAllowlist(db)).toEqual([both[0]])
  })
})

describe("audit", () => {
  it("chains a row for pin and drift-disable whose detail is a hash, not the body", () => {
    const db = pinned()
    checkDrift(db, "example-mail", [...PINNED_TOOLS, "delete_message"])
    expect(verifyChain(db)).toEqual({ ok: true, rows: 2 })

    const rows = auditRows(db)
    expect(rows.map((r) => [r["actor"], r["action"], r["target"]])).toEqual([
      ["owner", "connector.pinned", "example-mail"],
      ["system", "connector.disabled_drift", "example-mail"],
    ])
    const approvalRefHash = db
      .prepare("SELECT pin_approval_ref_hash FROM connectors WHERE name = ?")
      .get("example-mail")?.["pin_approval_ref_hash"]
    expect(rows[0]?.["detail_hash"]).toBe(
      expectedHash({ manifestHash: expectedHash(mail()), approvalRefHash })
    )
    for (const r of rows) {
      expect(String(r["detail_hash"])).toMatch(/^[0-9a-f]{64}$/)
    }
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain("api.example.com")
    expect(stored).not.toContain("delete_message")
  })
})

describe("manifestHash", () => {
  it("ignores key order", () => {
    const m = mail()
    const reordered: ConnectorManifest = {
      health: {
        breaker: { halfOpenProbeAfterMs: 30000, failureThreshold: 3 },
        backoff: { jitter: true, maxMs: 60000, baseMs: 500 },
      },
      ledgerMapping: { refField: "messageId", source: "email" },
      triggers: [{ intervalSeconds: 300, stream: "inbox", kind: "poll" }],
      operations: m.operations,
      egress: m.egress,
      auth: { scopes: ["mail.read", "mail.compose"], type: "oauth2" },
      description: m.description,
      version: 1,
      name: "example-mail",
    }
    expect(manifestHash(reordered)).toBe(expectedHash(m))
  })

  it.each<[string, (m: ConnectorManifest) => void]>([
    ["version", (m) => (m.version = 2)],
    ["description", (m) => (m.description = "Other")],
    ["auth scope", (m) => m.auth.scopes.push("mail.admin")],
    ["egress method", (m) => m.egress.hosts[0]?.methods.push("DELETE")],
    [
      "operation tier",
      (m) => {
        const op = m.operations[0]
        if (op) op.defaultTier = "approval"
      },
    ],
    [
      "untrusted flag",
      (m) => {
        const op = m.operations[0]
        if (op) op.untrustedOutput = false
      },
    ],
    [
      "trigger interval",
      (m) => {
        const t = m.triggers[0]
        if (t) t.intervalSeconds = 301
      },
    ],
    ["breaker threshold", (m) => (m.health.breaker.failureThreshold = 4)],
    ["jitter", (m) => (m.health.backoff.jitter = false)],
  ])("changes when the %s changes", (_label, mutate) => {
    const changed = mail()
    mutate(changed)
    expect(manifestHash(changed)).not.toBe(expectedHash(mail()))
  })
})
