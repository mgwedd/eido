import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import type { ConnectorManifest, Intent } from "@eido/schemas"
import { issueNonce, verifyApproval } from "../approvals"
import { beginRegistration, registerCredential } from "../credentials"
import { createExecutor } from "../executor"
import { propose } from "../intents"
import {
  BODY_MARKER,
  MAIL_OPS,
  WEBAUTHN,
  assertion,
  deviceChallenge,
  manifest,
  registration,
  sample,
  setup,
  testAuthenticator,
} from "../test-fixtures"
import type { Setup } from "../test-fixtures"
import { InMemoryVault } from "../vault/vault"
import { BRIDGE_PASSWORD_KEY, createProtonBridge } from "./bridge"
import { PROTON_CONNECTOR } from "./config"
import { rawMessage, startFakeBridge } from "./fake-bridge"
import type { FakeBridge } from "./fake-bridge"
import { BRIDGE_WRITERS, bridgeTransport } from "./writers"

// Issue #229. Core fills messageSha256, to and cc of a reply or forward proposal from the
// message it indexed (packages/core/src/connectors/reply-target.ts), and cannot import the gate
// or the fake Bridge. These tests build the args the way core does and run them through the
// executor against the fake Bridge. Expected recipients are written out by hand.

const IDENTITY = "assistant@example.com"
const PASSWORD = "synthetic-bridge-password-229"

const BRIDGE_OPS = MAIL_OPS.filter((op) =>
  ["email.reply", "email.forward"].includes(op.intentKind ?? "")
)

const protonManifest: ConnectorManifest = {
  ...manifest(PROTON_CONNECTOR, BRIDGE_OPS),
  auth: { type: "password", scopes: ["write"] },
  egress: { hosts: [] },
}

/** Core's hash of a message: SHA-256 of its raw bytes, lower-case hex. */
const coreSha256 = (raw: Buffer) =>
  createHash("sha256").update(raw).digest("hex")

const plain = rawMessage({
  messageId: "<plain@example.com>",
  subject: "Lunch",
  body: "lorem ipsum",
  from: "Sender <sender@example.com>",
  to: "Assistant <assistant@example.com>",
})

const withReplyTo = rawMessage({
  messageId: "<reply-to@example.com>",
  subject: "Plans",
  body: "lorem ipsum",
  from: "Sender <sender@example.com>",
  replyTo: "Desk <desk@example.com>",
  to: "Assistant <assistant@example.com>",
})

// Reply-To differs from From, the identity is in To, and Cc repeats an address already in To.
const crowded = rawMessage({
  messageId: "<crowded@example.com>",
  subject: "Offsite",
  body: "lorem ipsum",
  from: "Sender <sender@example.com>",
  replyTo: "Desk <desk@example.com>",
  to: "Owner <owner@example.com>, Assistant <assistant@example.com>",
  cc: "Owner <owner@example.com>, Carol <carol@example.com>",
})

let s: Setup | undefined
let fake: FakeBridge | undefined
afterEach(async () => {
  s?.cleanup()
  s = undefined
  await fake?.close()
  fake = undefined
})

/** Runs `intent` through propose, a signed approval and the executor; returns what Bridge saw. */
async function execute(intent: Intent) {
  s = setup([protonManifest])
  const db = s.db
  fake = await startFakeBridge({
    username: IDENTITY,
    password: PASSWORD,
    mailboxes: {
      INBOX: {
        uidValidity: 1700000001,
        uidNext: 4,
        messages: [
          { uid: 1, raw: plain, flags: [] },
          { uid: 2, raw: withReplyTo, flags: [] },
          { uid: 3, raw: crowded, flags: [] },
        ],
      },
      Drafts: { uidValidity: 1700000002, uidNext: 1, messages: [] },
      Trash: { uidValidity: 1700000003, uidNext: 1, messages: [] },
    },
  })
  const vault = new InMemoryVault()
  await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
  const bridge = createProtonBridge({
    config: {
      host: "127.0.0.1",
      imapPort: fake.imapPort,
      smtpPort: fake.smtpPort,
      tls: "none",
      username: IDENTITY,
      searchFolders: ["INBOX"],
    },
    vault,
  })
  const executor = createExecutor(db, BRIDGE_WRITERS, bridgeTransport(bridge))
  const auth = testAuthenticator()
  const begun = beginRegistration(db, "admin")
  if (!begun.ok) throw new Error("enrolment challenge refused")
  const enrolled = registerCredential(
    db,
    WEBAUTHN,
    "admin",
    registration(auth, begun.challenge)
  )
  if (!enrolled.ok) throw new Error("enrolment refused")

  const proposed = propose(db, s.policy, { intent, origin: "reactive" })
  if (!proposed.ok) throw new Error(`propose refused: ${proposed.code}`)
  const prepared = issueNonce(db, proposed.intentId)
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`)
  const approved = verifyApproval(db, WEBAUTHN, {
    intentId: proposed.intentId,
    nonce: prepared.nonce,
    assertion: assertion(
      auth,
      deviceChallenge(prepared.payloadHash, proposed.intentId, prepared.nonce)
    ),
  })
  if (!approved.ok) throw new Error("approval refused")
  return { result: await executor.execute(proposed.intentId), fake }
}

describe("core-shaped reply and forward intents against the fake Bridge", () => {
  it("sends a plain reply to the From address when there is no Reply-To", async () => {
    const { result, fake: bridge } = await execute(
      sample("email.reply", {
        messageId: "<plain@example.com>",
        messageSha256: coreSha256(plain),
        replyAll: false,
        to: ["sender@example.com"],
        body: BODY_MARKER,
      })
    )
    expect(result).toMatchObject({ ok: true })
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0]?.from).toBe(IDENTITY)
    expect(bridge.sent[0]?.to).toEqual(["sender@example.com"])
  })

  it("sends a plain reply to Reply-To, not From", async () => {
    const { result, fake: bridge } = await execute(
      sample("email.reply", {
        messageId: "<reply-to@example.com>",
        messageSha256: coreSha256(withReplyTo),
        replyAll: false,
        to: ["desk@example.com"],
        body: BODY_MARKER,
      })
    )
    expect(result).toMatchObject({ ok: true })
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0]?.to).toEqual(["desk@example.com"])
  })

  it("sends a reply-all to Reply-To, then To and Cc in header order, each address once and without the identity", async () => {
    const { result, fake: bridge } = await execute(
      sample("email.reply", {
        messageId: "<crowded@example.com>",
        messageSha256: coreSha256(crowded),
        replyAll: true,
        to: ["desk@example.com"],
        cc: ["owner@example.com", "carol@example.com"],
        body: BODY_MARKER,
      })
    )
    expect(result).toMatchObject({ ok: true })
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0]?.from).toBe(IDENTITY)
    expect(bridge.sent[0]?.to).toEqual([
      "desk@example.com",
      "owner@example.com",
      "carol@example.com",
    ])
    expect(bridge.sent[0]?.data).toMatch(
      /^Cc: owner@example\.com, carol@example\.com$/m
    )
  })

  it("sends a forward to the named recipient with the message the hash names", async () => {
    const { result, fake: bridge } = await execute(
      sample("email.forward", {
        messageId: "<crowded@example.com>",
        messageSha256: coreSha256(crowded),
        to: ["colleague@example.com"],
        note: BODY_MARKER,
      })
    )
    expect(result).toMatchObject({ ok: true })
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0]?.to).toEqual(["colleague@example.com"])
    expect(bridge.sent[0]?.data).toMatch(/^Subject: Fwd: Offsite$/m)
  })
})
