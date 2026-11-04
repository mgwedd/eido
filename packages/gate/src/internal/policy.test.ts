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
  SENSITIVITY_OVERLAY_FILE,
  ownerConfigOwnershipError,
  ownershipError,
  SHIPPED_DEFAULT_PATH,
  createStoredAttendeesReader,
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
  attendeeRecord,
  auditRows,
  manifest,
  sample,
  setup,
  signedFileRoots,
  signedPolicy,
  signedSensitivity,
  signedPin,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

let current: Setup | undefined

describe("owner-only config metadata", () => {
  it("never lowers file Trash to auto or lifts a forbidden manifest", () => {
    const s = fresh()
    s.policy.shipped.tiers["file.delete"] = "auto"
    expect(kindTier(s.db, s.policy, "file.delete")).toEqual({
      tier: "approval",
    })
    const files = manifest("files", FILE_OPS)
    files.version = 2
    const trash = files.operations.find(
      (operation) => operation.intentKind === "file.delete"
    )
    if (trash === undefined) throw new Error("missing trash operation")
    trash.defaultTier = "forbidden"
    signedPin(s.db, files)
    expect(kindTier(s.db, s.policy, "file.delete").tier).toBe("forbidden")
  })
  it("checks POSIX access bits and ownership independently of the host platform", () => {
    expect(ownerConfigOwnershipError(0o600, 42, "linux", 42)).toBeUndefined()
    expect(ownerConfigOwnershipError(0o640, 42, "linux", 42)).toContain(
      "accessible by group or others"
    )
    expect(ownerConfigOwnershipError(0o600, 43, "linux", 42)).toContain(
      "not owned by the gate user"
    )
    expect(ownerConfigOwnershipError(0o600, 43, "linux", null)).toBeUndefined()
    expect(ownerConfigOwnershipError(0o777, 43, "win32", 42)).toBeUndefined()
  })

  it("preserves the permissions overlay's write-only group restriction", () => {
    expect(ownershipError(0o600, 42, "linux", 42)).toBeUndefined()
    expect(ownershipError(0o620, 42, "linux", 42)).toContain(
      "writable by group or others"
    )
    expect(ownershipError(0o640, 42, "linux", 42)).toBeUndefined()
    expect(ownershipError(0o600, 43, "linux", 42)).toContain(
      "not owned by the gate user"
    )
    expect(ownershipError(0o600, 43, "linux", null)).toBeUndefined()
    expect(ownershipError(0o777, 43, "win32", 42)).toBeUndefined()
  })
})

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
    ["email.untrash", "approval"],
    ["calendar.create", "auto"],
    ["calendar.edit", "auto"],
    ["calendar.delete", "auto"],
    ["file.create", "auto"],
    ["file.rename", "auto"],
    ["file.move", "auto"],
    ["file.delete", "approval"],
    ["things.add_todo", "auto"],
  ]
  it.each(rows)("%s is %s", async (kind, tier) => {
    const { db, policy } = fresh()
    await signedFileRoots(db, {
      roots: [
        {
          id: "notes",
          root: {
            path: "/srv/example/notes",
            dev: "2a",
            ino: "1001",
            trashDir: "trash",
          },
        },
      ],
    })
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

  it("calendar.edit without guests on an event with a non-owner attendee is approval", () => {
    const { db, policy } = fresh(
      undefined,
      attendeeRecord({ "evt-1": [OWNER, "guest@example.com"] })
    )
    expect(
      intentTier(db, policy, sample("calendar.edit", { title: "Moved" }))
    ).toEqual({ tier: "approval" })
  })

  it("calendar.edit adding a guest to an owner-only event is approval, keeping it owner-only stays auto", () => {
    const { db, policy } = fresh()
    expect(
      intentTier(
        db,
        policy,
        sample("calendar.edit", { guests: ["guest@example.com"] })
      )
    ).toEqual({ tier: "approval" })
    expect(
      intentTier(db, policy, sample("calendar.edit", { guests: [OWNER] }))
    ).toEqual({ tier: "auto" })
  })

  it("calendar.delete of an event with a non-owner attendee is approval, of an owner-only event auto", () => {
    const { db, policy } = fresh(
      undefined,
      attendeeRecord({
        "evt-1": [" Owner@Example.com "],
        "evt-2": [OWNER, "guest@example.com"],
      })
    )
    expect(
      intentTier(db, policy, sample("calendar.delete", { eventUid: "evt-1" }))
    ).toEqual({ tier: "auto" })
    expect(
      intentTier(db, policy, sample("calendar.delete", { eventUid: "evt-2" }))
    ).toEqual({ tier: "approval" })
  })

  it("calendar edit and delete are approval when the stored attendees cannot be read", () => {
    const unreadable = [
      ["unknown event", attendeeRecord({})],
      [
        "reader throws",
        () => {
          throw new Error("ledger unavailable")
        },
      ],
    ] as const
    for (const [label, reader] of unreadable) {
      const s = setup(undefined, reader)
      try {
        for (const kind of ["calendar.edit", "calendar.delete"] as const) {
          expect(
            intentTier(s.db, s.policy, sample(kind)),
            `${label} ${kind}`
          ).toEqual({
            tier: "approval",
          })
        }
      } finally {
        s.cleanup()
      }
    }
  })

  it("calendar edit and delete are approval when no stored-attendee reader is configured", () => {
    const s = fresh()
    const { policy } = loadPolicy(s.db, {
      dataDir: s.dataDir,
      ownerAddresses: [OWNER],
      allowedRoots: [],
    })
    for (const kind of ["calendar.edit", "calendar.delete"] as const) {
      expect(intentTier(s.db, policy, sample(kind)), kind).toEqual({
        tier: "approval",
      })
    }
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
  it("keeps email.untrash approval tier even when a signed overlay requests auto", () => {
    const s = fresh()
    const overlay = { version: 1, tiers: { "email.untrash": "auto" } }
    s.writeOverlay(overlay)
    signedPolicy(s.db, overlay)
    const { policy, errors } = loadPolicy(s.db, s.options, s.policy)
    expect(errors).toEqual([])
    expect(intentTier(s.db, policy, sample("email.untrash"))).toEqual({
      tier: "approval",
    })
  })
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

  it("still loads after other signed policy.set targets are approved", async () => {
    const s = fresh()
    const overlay = { version: 1, tiers: { "email.draft": "approval" } }
    s.writeOverlay(overlay)
    signedPolicy(s.db, overlay)
    await signedFileRoots(s.db, {
      roots: [
        {
          id: "docs",
          root: {
            path: "/srv/example/docs",
            dev: "2a",
            ino: "1001",
            trashDir: "trash",
          },
        },
      ],
    })
    const { policy, errors } = loadPolicy(s.db, s.options, s.policy)
    expect(errors).toEqual([])
    expect(kindTier(s.db, policy, "email.draft")).toEqual({ tier: "approval" })
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

  it("confirm.field is approval by default, cannot be changed to auto, and needs no connector", () => {
    const s = fresh([])
    expect(kindTier(s.db, s.policy, "confirm.field")).toEqual({
      tier: "approval",
    })
    expect(intentTier(s.db, s.policy, sample("confirm.field"))).toEqual({
      tier: "approval",
    })

    // Even if shipped config were mutated to auto, kindTier returns approval
    s.policy.shipped.tiers["confirm.field"] = "auto"
    expect(kindTier(s.db, s.policy, "confirm.field")).toEqual({
      tier: "approval",
    })
    expect(intentTier(s.db, s.policy, sample("confirm.field"))).toEqual({
      tier: "approval",
    })

    // Overlay setting confirm.field to auto is rejected because it has no connector operation
    s.writeOverlay({ version: 1, tiers: { "confirm.field": "auto" } })
    const { errors } = loadPolicy(s.db, s.options, s.policy)
    expect(errors).toContain(
      'permissions.json: "confirm.field": auto needs an operation the pinned manifest marks reversible'
    )
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

describe("createStoredAttendeesReader", () => {
  it("reads attendees from store with attendees, guests, or event objects", () => {
    const store = new Map<
      string,
      {
        event?: Record<string, unknown>
        attendees?: string[]
        guests?: string[]
      }
    >()
    store.set("evt-attendees", { attendees: [OWNER, "guest@example.com"] })
    store.set("evt-guests", { guests: ["guest2@example.com"] })
    store.set("evt-tracked", { event: { guests: ["guest3@example.com"] } })
    store.set("evt-tracked-attendees", {
      event: { attendees: [{ address: OWNER }] },
    })

    const reader = createStoredAttendeesReader(store)
    expect(reader("evt-attendees")).toEqual({
      ok: true,
      attendees: [OWNER, "guest@example.com"],
    })
    expect(reader("evt-guests")).toEqual({
      ok: true,
      attendees: ["guest2@example.com"],
    })
    expect(reader("evt-tracked")).toEqual({
      ok: true,
      attendees: ["guest3@example.com"],
    })
    expect(reader("evt-tracked-attendees")).toEqual({
      ok: true,
      attendees: [OWNER],
    })
  })

  it("returns { ok: false } for unknown eventUid or read failure", () => {
    const store = {
      get: (uid: string) => {
        if (uid === "throw") throw new Error("store failure")
        return undefined
      },
    }
    const reader = createStoredAttendeesReader(store)
    expect(reader("unknown")).toEqual({ ok: false })
    expect(reader("throw")).toEqual({ ok: false })
  })
})

describe("the sensitivity guard", () => {
  it("escalates an auto write with sensitivity: 'sensitive' to approval; without it gets policy tier", () => {
    const s = fresh()
    const normalTodo = {
      kind: "things.add_todo" as const,
      args: { title: "buy printer paper" },
    }
    const sensitiveTodo = {
      ...normalTodo,
      sensitivity: "sensitive" as const,
    }
    expect(intentTier(s.db, s.policy, normalTodo)).toEqual({ tier: "auto" })
    expect(intentTier(s.db, s.policy, sensitiveTodo)).toEqual({
      tier: "approval",
    })
  })

  it("escalates another auto write with sensitivity: 'sensitive' to approval", async () => {
    const s = fresh()
    await signedFileRoots(s.db, {
      roots: [
        {
          id: "notes",
          root: {
            path: "/srv/example/notes",
            dev: "2a",
            ino: "1001",
            trashDir: "trash",
          },
        },
      ],
    })
    const normalFile = sample("file.create")
    const sensitiveFile = {
      ...normalFile,
      sensitivity: "sensitive" as const,
    }
    expect(intentTier(s.db, s.policy, normalFile)).toEqual({ tier: "auto" })
    expect(intentTier(s.db, s.policy, sensitiveFile)).toEqual({
      tier: "approval",
    })
  })

  describe("gate deterministic check on free text", () => {
    it.each([
      ["email address", "Email team at contact@example.com for update"],
      ["phone number", "Call reception at 555-123-4567"],
      ["phone number with parens", "Call (555) 234-5678 today"],
      ["12-digit number", "Billing reference 123456789012"],
      ["health term (doctor)", "Book doctor appointment"],
      ["health term (medical)", "Review medical diagnosis"],
      ["health term (prescription)", "Pick up prescription at pharmacy"],
      ["legal term (lawyer)", "Consult lawyer regarding agreement"],
      ["legal term (lawsuit)", "Prepare lawsuit documents"],
      ["money term (salary)", "Discuss annual salary increase"],
      ["money term (mortgage)", "Send mortgage payment"],
    ])(
      "escalates auto to-do containing %s to approval with no core flag",
      (_label, title) => {
        const s = fresh()
        const intent = {
          kind: "things.add_todo" as const,
          args: { title },
        }
        expect(intentTier(s.db, s.policy, intent)).toEqual({ tier: "approval" })
      }
    )

    it("checks free text across notes, text, and checklist items", () => {
      const s = fresh()
      const withNotes = {
        kind: "things.add_todo" as const,
        args: {
          title: "Buy groceries",
          notes: "Doctor said to avoid sugar",
        },
      }
      const withChecklist = {
        kind: "things.add_todo" as const,
        args: {
          title: "Errands",
          checklist: ["Apples", "Call 555-987-6543"],
        },
      }
      expect(intentTier(s.db, s.policy, withNotes)).toEqual({
        tier: "approval",
      })
      expect(intentTier(s.db, s.policy, withChecklist)).toEqual({
        tier: "approval",
      })
    })

    it("leaves ordinary synthetic to-do text ('buy printer paper') as auto", () => {
      const s = fresh()
      const intent = {
        kind: "things.add_todo" as const,
        args: { title: "buy printer paper" },
      }
      expect(intentTier(s.db, s.policy, intent)).toEqual({ tier: "auto" })
    })

    it("leaves ordinary multi-field to-do text as auto", () => {
      const s = fresh()
      const intent = {
        kind: "things.add_todo" as const,
        args: {
          title: "clean garage",
          notes: "reorganize shelves and sweep floor",
          checklist: ["boxes", "brooms", "tools"],
        },
      }
      expect(intentTier(s.db, s.policy, intent)).toEqual({ tier: "auto" })
    })
  })

  describe("tier invariants (cannot lower below policy table)", () => {
    it("never lowers approval tier to auto even with benign text and no sensitivity", () => {
      const s = fresh()
      const emailSend = sample("email.send")
      expect(intentTier(s.db, s.policy, emailSend)).toEqual({
        tier: "approval",
      })
      const confirmField = sample("confirm.field")
      expect(intentTier(s.db, s.policy, confirmField)).toEqual({
        tier: "approval",
      })
    })

    it("never lowers forbidden tier to auto or approval", () => {
      const s = fresh()
      const badRoot = {
        kind: "file.create" as const,
        args: {
          root: "unauthorized_root",
          path: "/unauthorized/path/file.txt",
          content: "Hello",
        },
        sensitivity: "sensitive" as const,
      }
      expect(intentTier(s.db, s.policy, badRoot)).toEqual({
        tier: "forbidden",
        reason: "root_not_allowed",
      })
    })
  })

  describe("signed sensitivity overlay", () => {
    it("extends terms and patterns with a signed overlay", () => {
      const s = fresh()
      const customTodo = {
        kind: "things.add_todo" as const,
        args: { title: "Work on Project Alpha" },
      }
      // Before overlay, Project Alpha is auto
      expect(intentTier(s.db, s.policy, customTodo)).toEqual({ tier: "auto" })

      // Sign and apply overlay with custom term
      const overlay = {
        version: 1,
        terms: {
          internal: ["Project Alpha"],
        },
      }
      s.writeSensitivityOverlay(overlay)
      signedSensitivity(s.db, overlay)
      const { policy } = loadPolicy(s.db, s.options, s.policy)
      expect(policy.sensitivity.terms["internal"]).toEqual(["Project Alpha"])
      expect(intentTier(s.db, policy, customTodo)).toEqual({ tier: "approval" })
    })

    it("rejects an invalid sensitivity overlay file and keeps prior config", () => {
      const s = fresh()
      const validOverlay = {
        version: 1,
        terms: {
          internal: ["custom_term_a"],
        },
      }
      s.writeSensitivityOverlay(validOverlay)
      signedSensitivity(s.db, validOverlay)
      const applied = loadPolicy(s.db, s.options, s.policy).policy

      // Now write invalid overlay with bad regex
      s.writeSensitivityOverlay({
        version: 1,
        patterns: { broken: "(unclosed" },
      })
      const { policy, errors } = loadPolicy(s.db, s.options, applied)
      expect(errors).toContain(
        'sensitivity.json: pattern "broken" is not a valid regex'
      )
      expect(policy).toBe(applied)
    })

    it("rejects non-JSON sensitivity overlay", () => {
      const s = fresh()
      writeFileSync(
        join(s.dataDir, SENSITIVITY_OVERLAY_FILE),
        "not valid json {{{"
      )
      const { policy, errors } = loadPolicy(s.db, s.options)
      expect(errors).toContain("sensitivity.json: not valid JSON")
      expect(policy.sensitivity).toBeDefined()
    })

    it("rejects directory sensitivity overlay", () => {
      const s = fresh()
      mkdirSync(join(s.dataDir, SENSITIVITY_OVERLAY_FILE))
      const { policy, errors } = loadPolicy(s.db, s.options)
      expect(errors).toContain("sensitivity.json: not a regular file")
      expect(policy.sensitivity).toBeDefined()
    })

    it.each([
      [
        "not an object",
        [],
        "sensitivity.json: expected an object with version and optional patterns or terms",
      ],
      [
        "missing version",
        {},
        "sensitivity.json: version must be a positive integer",
      ],
      [
        "non-object patterns",
        { version: 1, patterns: "bad" },
        "sensitivity.json: patterns must be an object of regex strings",
      ],
      [
        "empty pattern",
        { version: 1, patterns: { empty: "" } },
        'sensitivity.json: pattern "empty" must be a non-empty string',
      ],
      [
        "non-object terms",
        { version: 1, terms: "bad" },
        "sensitivity.json: terms must be an object of string arrays",
      ],
      [
        "non-array term category",
        { version: 1, terms: { cat: "bad" } },
        'sensitivity.json: terms category "cat" must be an array of non-empty strings',
      ],
    ])("rejects sensitivity overlay %s", (_name, overlay, error) => {
      const s = fresh()
      s.writeSensitivityOverlay(overlay)
      const { errors } = loadPolicy(s.db, s.options)
      expect(errors).toContain(error)
    })
  })
})
