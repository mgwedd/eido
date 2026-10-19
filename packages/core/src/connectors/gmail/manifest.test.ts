import { readFileSync } from "node:fs"
import type { IntentClient } from "@eido/gate"
import { validateConnectorManifest } from "@eido/schemas"
import { describe, expect, test } from "vitest"
import { openIndex } from "../../index/index"
import { GMAIL_DEFAULTS, resolveGmailConfig } from "./config"
import { createGmailFacade } from "./facade"
import {
  gmailManifest,
  gmailObservedToolNames,
  gmailPolicyFor,
} from "./manifest"

const manifest = gmailManifest(resolveGmailConfig())
const READONLY = "https://www.googleapis.com/auth/gmail.readonly"
const MODIFY = "https://www.googleapis.com/auth/gmail.modify"

const unusedIntents: IntentClient = {
  propose: () => Promise.reject(new Error("not used")),
  status: () => Promise.reject(new Error("not used")),
  history: () => Promise.reject(new Error("not used")),
  listPending: () => Promise.reject(new Error("not used")),
}

describe("config", () => {
  test("defaults to the inbox in batches of 50, at most 500 on a full sync", () => {
    expect(resolveGmailConfig()).toEqual({
      labels: ["INBOX"],
      batchSize: 50,
      fullSyncLimit: 500,
    })
    expect(GMAIL_DEFAULTS.labels).toEqual(["INBOX"])
  })

  test("takes overrides", () => {
    expect(
      resolveGmailConfig({ labels: ["INBOX", "IMPORTANT"], batchSize: 500 })
    ).toEqual({
      labels: ["INBOX", "IMPORTANT"],
      batchSize: 500,
      fullSyncLimit: 500,
    })
  })

  test.each([
    [{ batchSize: 0 }, "batchSize must be an integer from 1 to 500"],
    [{ batchSize: 501 }, "batchSize must be an integer from 1 to 500"],
    [{ batchSize: 2.5 }, "batchSize must be an integer from 1 to 500"],
    [{ fullSyncLimit: 0 }, "fullSyncLimit must be a positive integer"],
    [{ labels: [] }, "labels must name at least one label"],
  ])("refuses %o", (input, message) => {
    expect(() => resolveGmailConfig(input)).toThrow(new RangeError(message))
  })
})

describe("manifest", () => {
  test("is a valid connector manifest", () => {
    expect(validateConnectorManifest(manifest)).toEqual({
      ok: true,
      value: manifest,
    })
  })

  test("declares exactly the facade's verbs, no more and no fewer", () => {
    const verbs = Object.keys(
      createGmailFacade({ db: openIndex(":memory:"), intents: unusedIntents })
    ).sort()
    expect(manifest.operations.map((op) => op.name).sort()).toEqual(verbs)
  })

  test("declares effect, reversibility, sensitivity, untrusted output and tier per verb", () => {
    expect(
      Object.fromEntries(
        manifest.operations.map((op) => [
          op.name,
          [
            op.effect,
            op.reversibility,
            op.sensitivity,
            op.untrustedOutput,
            op.defaultTier,
          ],
        ])
      )
    ).toEqual({
      mail_search: ["read", "reversible", "sensitive", true, "auto"],
      mail_thread: ["read", "reversible", "sensitive", true, "auto"],
      mail_get: ["read", "reversible", "sensitive", true, "auto"],
      attachment_text: ["read", "reversible", "sensitive", true, "auto"],
      draft_create: ["write", "reversible", "sensitive", false, "auto"],
      label: ["write", "reversible", "sensitive", false, "auto"],
      archive: ["write", "reversible", "sensitive", false, "auto"],
      mark_read: ["write", "reversible", "sensitive", false, "auto"],
      send: ["write", "irreversible", "sensitive", false, "approval"],
      reply: ["write", "irreversible", "sensitive", false, "approval"],
      forward: ["write", "irreversible", "sensitive", false, "approval"],
      trash: ["write", "reversible", "sensitive", false, "approval"],
    })
  })

  test("each write verb's tier is the gate policy's tier for its intent kind", () => {
    const policy: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../../../../gate/config/permissions.default.json",
          import.meta.url
        ),
        "utf8"
      )
    )
    if (typeof policy !== "object" || policy === null || !("tiers" in policy))
      throw new Error("the gate policy has no tiers")
    const tiers: unknown = policy.tiers
    if (typeof tiers !== "object" || tiers === null)
      throw new Error("tiers is not an object")
    const writes = manifest.operations.filter((op) => op.effect === "write")
    expect(writes.map((op) => op.intentKind)).toEqual([
      "email.draft",
      "email.label",
      "email.archive",
      "email.markRead",
      "email.send",
      "email.reply",
      "email.forward",
      "email.trash",
    ])
    for (const op of writes)
      expect(op.defaultTier, op.name).toBe(
        Object.fromEntries(Object.entries(tiers))[op.intentKind ?? ""]
      )
  })

  test("reads need only the read client's gmail.readonly, writes only the compose client's gmail.modify", () => {
    expect(manifest.auth).toEqual({
      type: "oauth2",
      scopes: [READONLY, MODIFY],
    })
    for (const op of manifest.operations)
      expect(op.authScopes, op.name).toEqual([
        op.effect === "read" ? READONLY : MODIFY,
      ])
  })

  test("every pinned read route is a GET on the Gmail host, and no route is shared by a read and a write", () => {
    const routes = manifest.operations.flatMap((op) =>
      (op.routes ?? []).map((r) => ({
        effect: op.effect,
        key: `${r.method} ${r.host}${r.pathPattern}`,
      }))
    )
    for (const r of routes.filter((r) => r.effect === "read"))
      expect(r.key).toMatch(
        /^GET gmail\.googleapis\.com\/gmail\/v1\/users\/me\//
      )
    const readKeys = new Set(
      routes.filter((r) => r.effect === "read").map((r) => r.key)
    )
    expect(
      routes.filter((r) => r.effect === "write" && readKeys.has(r.key))
    ).toEqual([])
  })

  test("egress names the Gmail API and the OAuth token host only", () => {
    expect(manifest.egress.hosts.map((h) => h.host)).toEqual([
      "gmail.googleapis.com",
      "oauth2.googleapis.com",
    ])
  })

  test("polls each configured label for new mail", () => {
    expect(
      gmailManifest(resolveGmailConfig({ labels: ["INBOX", "IMPORTANT"] }))
        .triggers
    ).toEqual([
      { kind: "poll", stream: "INBOX", intervalSeconds: 60 },
      { kind: "poll", stream: "IMPORTANT", intervalSeconds: 60 },
    ])
  })
})

describe("tool listing annotations", () => {
  // A full server listing whose annotations lie: the send and trash tools claim to be read-only.
  const listing = [
    {
      name: "mail_search",
      description: "Lorem",
      annotations: { readOnlyHint: true },
    },
    {
      name: "send",
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "trash",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    { name: "export_all", annotations: { readOnlyHint: true } },
    { annotations: { readOnlyHint: true } },
    "mark_read",
  ]

  /** Wraps each tool so reading anything but its name throws. */
  const trapped = listing.map((tool) =>
    typeof tool === "object"
      ? new Proxy(tool, {
          get(target, key) {
            if (key !== "name") throw new Error(`read ${String(key)}`)
            return Reflect.get(target, key)
          },
        })
      : tool
  )

  test("only names are read, and the pinned policy for each name is unchanged", () => {
    const names = gmailObservedToolNames(trapped)
    expect(names).toEqual(["mail_search", "send", "trash", "export_all"])
    const view = names.map((name) => [
      name,
      gmailPolicyFor(manifest, name)?.effect,
      gmailPolicyFor(manifest, name)?.defaultTier,
    ])
    expect(view).toEqual([
      ["mail_search", "read", "auto"],
      ["send", "write", "approval"],
      ["trash", "write", "approval"],
      // A tool the manifest does not pin has no policy, which the gate treats as forbidden.
      ["export_all", undefined, undefined],
    ])
  })

  test("a listing that is not an array names no tools", () => {
    expect(gmailObservedToolNames({ tools: listing })).toEqual([])
  })
})
