import type { IntentClient } from "@eido/gate"
import { validateConnectorManifest } from "@eido/schemas"
import { describe, expect, test } from "vitest"
import { resolveConfig } from "./config"
import { createProtonFacade } from "./facade"
import {
  BRIDGE_SCOPE,
  observedToolNames,
  policyFor,
  protonManifest,
} from "./manifest"
import { openIndex } from "../../index/index"

const config = resolveConfig({
  username: "assistant@example.com",
  folders: ["INBOX", "Folders/Work"],
})
const manifest = protonManifest(config)

describe("manifest", () => {
  test("is valid under the pinned manifest schema", () => {
    expect(validateConnectorManifest(manifest)).toMatchObject({ ok: true })
  })

  test("declares effect, reversibility, sensitivity, untrusted flag and tier for each verb", () => {
    const table = manifest.operations.map((op) => [
      op.name,
      op.effect,
      op.reversibility,
      op.sensitivity,
      op.untrustedOutput,
      op.defaultTier,
      op.intentKind ?? null,
    ])
    expect(table).toEqual([
      ["mail_search", "read", "reversible", "sensitive", true, "auto", null],
      ["mail_thread", "read", "reversible", "sensitive", true, "auto", null],
      ["mail_get", "read", "reversible", "sensitive", true, "auto", null],
      [
        "attachment_text",
        "read",
        "reversible",
        "sensitive",
        true,
        "auto",
        null,
      ],
      [
        "draft_create",
        "write",
        "reversible",
        "sensitive",
        false,
        "auto",
        "email.draft",
      ],
      [
        "send",
        "write",
        "irreversible",
        "sensitive",
        false,
        "approval",
        "email.send",
      ],
      [
        "reply",
        "write",
        "irreversible",
        "sensitive",
        false,
        "approval",
        "email.reply",
      ],
      [
        "forward",
        "write",
        "irreversible",
        "sensitive",
        false,
        "approval",
        "email.forward",
      ],
      [
        "trash",
        "write",
        "reversible",
        "sensitive",
        false,
        "approval",
        "email.trash",
      ],
    ])
  })

  test("facade verbs and manifest operations are the same set", () => {
    const facade = createProtonFacade({
      db: openIndex(":memory:"),
      intents: {} as IntentClient,
      identity: "assistant@example.com",
      profile: { getProfile: () => Promise.resolve(null) },
    })
    expect(Object.keys(facade).sort()).toEqual(
      manifest.operations.map((op) => op.name).sort()
    )
  })

  test("auth is a password scope, Bridge endpoints are pinned, triggers follow the folders", () => {
    expect(manifest.auth).toEqual({ type: "password", scopes: [BRIDGE_SCOPE] })
    expect(manifest.egress.hosts).toEqual([])
    expect(manifest.egress.local).toEqual([
      { protocol: "imap", host: "127.0.0.1", port: 1143 },
      { protocol: "smtp", host: "127.0.0.1", port: 1025 },
    ])
    expect(manifest.triggers.map((t) => t.stream)).toEqual([
      "INBOX",
      "Folders/Work",
    ])
    expect(manifest.health.breaker.failureThreshold).toBeGreaterThan(0)
  })

  test("the manifest holds no secret field", () => {
    expect(JSON.stringify(manifest)).not.toMatch(/passw[a-z]*"\s*:\s*"/i)
  })
})

describe("policy reads the pinned manifest, never tool annotations", () => {
  const trap = (name: string) => ({
    name,
    get annotations(): never {
      throw new Error(`annotations were read for ${name}`)
    },
  })

  test("a listing whose annotations call send read-only changes nothing, and annotations are never touched", () => {
    const before = manifest.operations.map((op) => policyFor(manifest, op.name))
    const listing = [
      trap("mail_search"),
      trap("send"),
      {
        name: "trash",
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      "not a tool",
      { nameless: true },
    ]
    expect(observedToolNames(listing)).toEqual(["mail_search", "send", "trash"])
    const after = manifest.operations.map((op) => policyFor(manifest, op.name))
    expect(after).toEqual(before)
    expect(policyFor(manifest, "send")).toMatchObject({
      effect: "write",
      reversibility: "irreversible",
      defaultTier: "approval",
    })
    expect(policyFor(manifest, "export_everything")).toBeUndefined()
  })

  test("a listing that is not an array has no tools", () => {
    expect(observedToolNames({ tools: [] })).toEqual([])
  })
})

describe("config", () => {
  test("defaults mirror INBOX in batches of 50", () => {
    expect(resolveConfig({ username: "assistant@example.com" })).toEqual({
      username: "assistant@example.com",
      folders: ["INBOX"],
      batchSize: 50,
    })
  })

  test("has no host, port, TLS or secret field: those live on the gate side", () => {
    expect(
      Object.keys(resolveConfig({ username: "assistant@example.com" }))
    ).toEqual(["folders", "batchSize", "username"])
  })

  test.each([
    [{ batchSize: 0 }, /batchSize/],
    [{ batchSize: 1.5 }, /batchSize/],
    [{ username: "no-at-sign" }, /address/],
    [{ folders: [] }, /folders/],
  ])("refuses %j", (input, message) => {
    expect(() =>
      resolveConfig({ username: "assistant@example.com", ...input })
    ).toThrow(message)
  })
})
