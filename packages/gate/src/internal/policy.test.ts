import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { INTENT_KINDS } from "@eido/schemas"
import { afterEach, describe, expect, it } from "vitest"
import { verifyChain } from "./audit"
import { payloadHash } from "./canonical"
import { checkDrift } from "./connectors"
import {
  OVERLAY_FILE,
  SHIPPED_DEFAULT_PATH,
  intentTier,
  kindTier,
  loadPolicy,
} from "./policy"
import type { IntentKind } from "./policy"
import {
  CALENDAR_OPS,
  FILE_OPS,
  MAIL_OPS,
  OWNER,
  auditRows,
  manifest,
  sample,
  setup,
  signedPolicy,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

let current: Setup | undefined

function shippedTiers(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || !("tiers" in value)) {
    throw new Error("shipped table has no tiers")
  }
  const { tiers } = value
  if (typeof tiers !== "object" || tiers === null) {
    throw new Error("shipped tiers is not an object")
  }
  return Object.fromEntries(Object.entries(tiers))
}

function fresh(...args: Parameters<typeof setup>): Setup {
  current = setup(...args)
  return current
}

afterEach(() => {
  current?.cleanup()
  current = undefined
})

describe("the default tier table", () => {
  const rows: Array<[IntentKind, "auto" | "approval"]> = [
    ["email.draft", "auto"],
    ["email.label", "auto"],
    ["email.archive", "auto"],
    ["email.markRead", "auto"],
    ["email.send", "approval"],
    ["email.reply", "approval"],
    ["email.forward", "approval"],
    ["email.trash", "approval"],
    ["calendar.create", "auto"],
    ["calendar.edit", "auto"],
    ["calendar.delete", "auto"],
    ["file.create", "auto"],
    ["file.rename", "auto"],
    ["file.move", "auto"],
    ["file.delete", "approval"],
  ]
  it.each(rows)("%s is %s", (kind, tier) => {
    const { db, policy } = fresh()
    expect(intentTier(db, policy, sample(kind))).toEqual({ tier })
  })

  it("calendar with only the owner as guest is auto, any other guest forces approval", () => {
    const { db, policy } = fresh()
    const ownerOnly = { guests: [" Owner@Example.com "] }
    expect(
      intentTier(db, policy, sample("calendar.create", ownerOnly))
    ).toEqual({ tier: "auto" })
    expect(intentTier(db, policy, sample("calendar.edit", ownerOnly))).toEqual({
      tier: "auto",
    })
    const withGuest = { guests: [OWNER, "guest@example.com"] }
    expect(
      intentTier(db, policy, sample("calendar.create", withGuest))
    ).toEqual({ tier: "approval" })
    expect(intentTier(db, policy, sample("calendar.edit", withGuest))).toEqual({
      tier: "approval",
    })
  })

  it("a file op on an unlisted root is forbidden", () => {
    const { db, policy } = fresh()
    for (const kind of [
      "file.create",
      "file.rename",
      "file.move",
      "file.delete",
    ] as const) {
      expect(intentTier(db, policy, sample(kind, { root: "secrets" }))).toEqual(
        { tier: "forbidden", reason: "root_not_allowed" }
      )
    }
  })

  it("reminder.create has no pinned operation and is forbidden", () => {
    const { db, policy } = fresh()
    expect(intentTier(db, policy, sample("reminder.create"))).toEqual({
      tier: "forbidden",
      reason: "no_operation",
    })
  })

  it("with no overlay, every kind's tier equals its shipped entry, and the file is versioned", () => {
    const { db, policy } = fresh()
    const shipped: unknown = JSON.parse(
      readFileSync(SHIPPED_DEFAULT_PATH, "utf8")
    )
    expect(shipped).toMatchObject({ version: 1 })
    expect(policy.overlay).toBeUndefined()
    const tiers = shippedTiers(shipped)
    for (const kind of INTENT_KINDS) {
      const decision = kindTier(db, policy, kind)
      if (kind in tiers) {
        expect(decision, kind).toEqual({ tier: tiers[kind] })
      } else {
        expect(decision.tier, kind).toBe("forbidden")
      }
    }
  })
})

describe("the overlay", () => {
  it("tightens email.archive to approval and loosens email.trash to auto", () => {
    const s = fresh()
    s.writeOverlay({
      version: 1,
      tiers: { "email.archive": "approval", "email.trash": "auto" },
    })
    signedPolicy(s.db, {
      version: 1,
      tiers: { "email.archive": "approval", "email.trash": "auto" },
    })
    const { policy, errors } = loadPolicy(s.db, s.options, s.policy)
    expect(errors).toEqual([])
    expect(kindTier(s.db, policy, "email.archive")).toEqual({
      tier: "approval",
    })
    expect(kindTier(s.db, policy, "email.trash")).toEqual({ tier: "auto" })
    // Untouched kinds keep the shipped tier.
    expect(kindTier(s.db, policy, "email.label")).toEqual({ tier: "auto" })
  })

  it("is applied on first load too", () => {
    const s = fresh()
    s.writeOverlay({ version: 1, tiers: { "email.draft": "approval" } })
    signedPolicy(s.db, { version: 1, tiers: { "email.draft": "approval" } })
    const { policy } = loadPolicy(s.db, s.options)
    expect(kindTier(s.db, policy, "email.draft")).toEqual({ tier: "approval" })
  })

  it("is refused when group or others may write it", () => {
    if (process.platform === "win32") return
    const s = fresh()
    s.writeOverlay({ version: 1, tiers: { "email.trash": "auto" } })
    chmodSync(join(s.dataDir, OVERLAY_FILE), 0o666)
    const { policy, errors } = loadPolicy(s.db, s.options, s.policy)
    expect(errors).toEqual([
      `${OVERLAY_FILE}: writable by group or others; only the gate user may write it`,
    ])
    expect(kindTier(s.db, policy, "email.trash")).toEqual({ tier: "approval" })
  })

  it("an unreadable overlay path is an error, not an absent overlay", () => {
    const s = fresh()
    mkdirSync(join(s.dataDir, OVERLAY_FILE))
    expect(() => loadPolicy(s.db, s.options, s.policy)).toThrow()
  })
})

describe("guards no config can lift", () => {
  it("rejects auto for a kind whose pinned operation is not reversible, naming the kind", () => {
    const s = fresh()
    s.writeOverlay({ version: 1, tiers: { "email.send": "auto" } })
    const { policy, errors } = loadPolicy(s.db, s.options, s.policy)
    expect(errors).toEqual([
      `${OVERLAY_FILE}: "email.send": auto needs an operation the pinned manifest marks reversible`,
    ])
    expect(kindTier(s.db, policy, "email.send")).toEqual({ tier: "approval" })
  })

  it("downgrades a shipped auto on an irreversible operation to approval", () => {
    const irreversibleDraft = MAIL_OPS.map((entry) =>
      entry.intentKind === "email.draft"
        ? {
            ...entry,
            reversibility: "irreversible" as const,
            defaultTier: "approval" as const,
          }
        : entry
    )
    const { db, policy } = fresh([manifest("mail", irreversibleDraft)])
    expect(kindTier(db, policy, "email.draft")).toEqual({ tier: "approval" })
  })

  it("a kind absent from the verb list is forbidden", () => {
    const { db, policy } = fresh()
    expect(kindTier(db, policy, "money.transfer")).toEqual({
      tier: "forbidden",
      reason: "unknown_kind",
    })
  })

  it("a kind absent from the pinned manifests is forbidden even with an overlay entry", () => {
    const s = fresh([manifest("mail", MAIL_OPS)])
    s.writeOverlay({ version: 1, tiers: { "file.delete": "approval" } })
    signedPolicy(s.db, { version: 1, tiers: { "file.delete": "approval" } })
    const { policy, errors } = loadPolicy(s.db, s.options, s.policy)
    expect(errors).toEqual([])
    expect(kindTier(s.db, policy, "file.delete")).toEqual({
      tier: "forbidden",
      reason: "no_operation",
    })
  })

  it("a manifest forbidden stays forbidden whatever the config says", () => {
    const forbiddenTrash = MAIL_OPS.map((entry) =>
      entry.intentKind === "email.trash"
        ? { ...entry, defaultTier: "forbidden" as const }
        : entry
    )
    const s = fresh([manifest("mail", forbiddenTrash)])
    s.writeOverlay({ version: 1, tiers: { "email.trash": "approval" } })
    signedPolicy(s.db, { version: 1, tiers: { "email.trash": "approval" } })
    const { policy } = loadPolicy(s.db, s.options, s.policy)
    expect(kindTier(s.db, policy, "email.trash")).toEqual({
      tier: "forbidden",
      reason: "manifest_forbidden",
    })
  })

  it("a kind two connectors claim is forbidden", () => {
    const { db, policy } = fresh([
      manifest("mail", MAIL_OPS),
      manifest("mail-two", MAIL_OPS),
    ])
    expect(kindTier(db, policy, "email.send")).toEqual({
      tier: "forbidden",
      reason: "ambiguous_operation",
    })
  })

  it("a drift-disabled connector exposes nothing", () => {
    const s = fresh([
      manifest("calendar", CALENDAR_OPS),
      manifest("files", FILE_OPS),
    ])
    checkDrift(s.db, "files", ["create_file"])
    expect(kindTier(s.db, s.policy, "file.create")).toEqual({
      tier: "forbidden",
      reason: "connector_disabled",
    })
    expect(kindTier(s.db, s.policy, "calendar.create")).toEqual({
      tier: "auto",
    })
  })
})

describe("policy changes are audited", () => {
  it("logs policy.loaded on first load, policy.changed with before and after hashes on a change", () => {
    const s = fresh()
    const loaded = auditRows(s.db).filter((r) => r.action === "policy.loaded")
    const shipped: unknown = JSON.parse(
      readFileSync(SHIPPED_DEFAULT_PATH, "utf8")
    )
    const before = payloadHash({ shipped, overlay: null })
    expect(loaded).toEqual([
      expect.objectContaining({
        actor: "system",
        target: join(s.dataDir, OVERLAY_FILE),
        detail_hash: payloadHash({ after_hash: before }),
      }),
    ])

    const overlay = { version: 1, tiers: { "email.archive": "approval" } }
    s.writeOverlay(overlay)
    signedPolicy(s.db, overlay)
    const { policy } = loadPolicy(s.db, s.options, s.policy)
    const changed = auditRows(s.db).filter((r) => r.action === "policy.changed")
    expect(changed).toEqual([
      expect.objectContaining({
        actor: "owner",
        target: "permissions",
      }),
    ])
    expect(JSON.stringify(auditRows(s.db))).not.toContain("email.archive")
    expect(verifyChain(s.db).ok).toBe(true)

    // Reloading the same config changes nothing and logs nothing.
    loadPolicy(s.db, s.options, policy)
    expect(
      auditRows(s.db).filter((r) => r.action === "policy.changed")
    ).toHaveLength(1)
  })
})

describe("invalid overlays are rejected, not applied, and audited", () => {
  const cases: Array<[string, unknown, string]> = [
    [
      "unknown kind",
      { version: 1, tiers: { "money.transfer": "auto" } },
      `${OVERLAY_FILE}: "money.transfer": unknown intent kind`,
    ],
    [
      "forbidden tier",
      { version: 1, tiers: { "email.archive": "forbidden" } },
      `${OVERLAY_FILE}: "email.archive": tier must be "auto" or "approval" (forbidden is not configurable)`,
    ],
    [
      "array instead of object",
      [],
      `${OVERLAY_FILE}: expected an object with version and tiers`,
    ],
    [
      "missing version",
      { tiers: { "email.archive": "approval" } },
      `${OVERLAY_FILE}: version must be a positive integer`,
    ],
    [
      "tiers not an object",
      { version: 1, tiers: ["email.archive"] },
      `${OVERLAY_FILE}: tiers must be an object`,
    ],
    [
      "extra key",
      { version: 1, tiers: {}, owner: "x" },
      `${OVERLAY_FILE}: unknown key "owner"`,
    ],
    ["not JSON", "{ version: 1", `${OVERLAY_FILE}: not valid JSON`],
    [
      "guard violation",
      { version: 1, tiers: { "email.forward": "auto" } },
      `${OVERLAY_FILE}: "email.forward": auto needs an operation the pinned manifest marks reversible`,
    ],
  ]

  it.each(cases)("%s", (_name, overlay, error) => {
    const s = fresh()
    s.writeOverlay({ version: 1, tiers: { "email.archive": "approval" } })
    signedPolicy(s.db, { version: 1, tiers: { "email.archive": "approval" } })
    const applied = loadPolicy(s.db, s.options, s.policy).policy
    s.writeOverlay(overlay)
    const raw = readFileSync(join(s.dataDir, OVERLAY_FILE))
    const { policy, errors } = loadPolicy(s.db, s.options, applied)
    expect(errors).toContain(error)
    // The previously applied policy stays in force.
    expect(policy).toBe(applied)
    expect(kindTier(s.db, policy, "email.archive")).toEqual({
      tier: "approval",
    })
    const rejected = auditRows(s.db).filter(
      (r) => r.action === "policy.rejected"
    )
    expect(rejected).toEqual([
      expect.objectContaining({
        actor: "system",
        detail_hash: payloadHash({
          file_hash: createHash("sha256").update(raw).digest("hex"),
          errors,
        }),
      }),
    ])
    expect(verifyChain(s.db).ok).toBe(true)
  })

  it("on first load a rejected overlay leaves the shipped table alone in force", () => {
    const s = fresh()
    s.writeOverlay({ version: 1, tiers: { "email.trash": "forbidden" } })
    const { policy, errors } = loadPolicy(s.db, s.options)
    expect(errors).toHaveLength(1)
    expect(policy.overlay).toBeUndefined()
    expect(kindTier(s.db, policy, "email.trash")).toEqual({ tier: "approval" })
  })

  it("an invalid shipped table stops the gate", () => {
    const s = fresh()
    const shippedPath = join(s.dataDir, "shipped.json")
    writeFileSync(shippedPath, JSON.stringify({ version: 0, tiers: {} }))
    expect(() => loadPolicy(s.db, { ...s.options, shippedPath })).toThrow(
      "invalid shipped permission table: permissions.default.json: version must be a positive integer"
    )
  })
})
