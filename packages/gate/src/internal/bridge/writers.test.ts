import type { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import type { ConnectorManifest, Intent } from "@eido/schemas"
import { issueNonce, verifyApproval } from "../approvals"
import { canonicalize } from "../canonical"
import { beginRegistration, registerCredential } from "../credentials"
import { createExecutor } from "../executor"
import type { WriteRequest } from "../executor"
import { propose } from "../intents"
import {
  BODY_MARKER,
  MAIL_OPS,
  WEBAUTHN,
  assertion,
  auditRows,
  deviceChallenge,
  loggedText,
  manifest,
  registration,
  sample,
  setup,
  testAuthenticator,
} from "../test-fixtures"
import type { Setup, TestAuthenticator } from "../test-fixtures"
import { InMemoryVault } from "../vault/vault"
import { BRIDGE_PASSWORD_KEY, createProtonBridge } from "./bridge"
import type { FoundMessage } from "./bridge"
import { PROTON_CONNECTOR } from "./config"
import { rawMessage, startFakeBridge } from "./fake-bridge"
import type { FakeBridge } from "./fake-bridge"
import {
  BRIDGE_WRITERS,
  bridgeTransport,
  prefixed,
  replyRecipients,
} from "./writers"

const USER = "assistant@example.invalid"
const PASSWORD = "synthetic-bridge-password-91aa"

const BRIDGE_OPS = MAIL_OPS.filter((op) =>
  [
    "email.draft",
    "email.send",
    "email.reply",
    "email.forward",
    "email.trash",
  ].includes(op.intentKind ?? "")
)

/** Core's Proton manifest shape (#22): password auth and no HTTP egress. */
function protonManifest(name = PROTON_CONNECTOR): ConnectorManifest {
  return {
    ...manifest(name, BRIDGE_OPS),
    auth: { type: "password", scopes: ["write"] },
    egress: { hosts: [] },
  }
}

const original = rawMessage({
  messageId: "<original@example.invalid>",
  subject: "Plans",
  body: "lorem ipsum",
  references: "<root@example.invalid>",
  replyTo: "Desk <desk@example.invalid>",
  to: "Owner <owner@example.invalid>, assistant@example.invalid",
  cc: "Carol <carol@example.invalid>",
})

let s: Setup | undefined
let fake: FakeBridge | undefined
afterEach(async () => {
  s?.cleanup()
  s = undefined
  await fake?.close()
  fake = undefined
})

type World = {
  db: DatabaseSync
  fake: FakeBridge
  auth: TestAuthenticator
  run: (id: string) => ReturnType<ReturnType<typeof createExecutor>["execute"]>
  propose: (intent: Intent) => string
}

async function world(connector = protonManifest()): Promise<World> {
  s = setup([connector])
  const db = s.db
  const policy = s.policy
  fake = await startFakeBridge({
    username: USER,
    password: PASSWORD,
    mailboxes: {
      INBOX: {
        uidValidity: 1700000001,
        uidNext: 8,
        messages: [{ uid: 7, raw: original, flags: [] }],
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
      allowSelfSigned: false,
      username: USER,
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
  return {
    db,
    fake,
    auth,
    run: (id) => executor.execute(id),
    propose: (intent) => {
      const result = propose(db, policy, { intent, origin: "reactive" })
      if (!result.ok) throw new Error(result.code)
      return result.intentId
    },
  }
}

/** The owner's signed approval, through the same verification the phone route uses. */
function approve(w: World, id: string): void {
  const prepared = issueNonce(w.db, id)
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`)
  const result = verifyApproval(w.db, WEBAUTHN, {
    intentId: id,
    nonce: prepared.nonce,
    assertion: assertion(
      w.auth,
      deviceChallenge(prepared.payloadHash, id, prepared.nonce)
    ),
  })
  if (!result.ok) throw new Error("approval refused")
}

const writes = (f: FakeBridge) =>
  f.imapCommands.filter((command) => /^(APPEND|UID MOVE)/.test(command))

describe("Bridge writers through the executor", () => {
  it("runs an auto-tier draft as one APPEND to Drafts and sends nothing", async () => {
    const w = await world()
    const id = w.propose(
      sample("email.draft", {
        to: ["guest@example.invalid"],
        bcc: ["hidden@example.invalid"],
        subject: "Agenda",
        body: BODY_MARKER,
        inReplyToMessageId: "<original@example.invalid>",
      })
    )
    const result = await w.run(id)
    expect(result).toMatchObject({
      ok: true,
      result: { folder: "Drafts", uid: 1 },
    })
    expect(writes(w.fake)).toEqual([
      expect.stringMatching(/^APPEND Drafts \(\\Draft \\Seen\)/),
    ])
    expect(w.fake.smtpCommands).toEqual([])
    const draft =
      w.fake.mailboxes.get("Drafts")?.messages[0]?.raw.toString("utf8") ?? ""
    expect(draft).toMatch(/^From: assistant@example\.invalid$/m)
    expect(draft).toMatch(/^Bcc: hidden@example\.invalid$/m)
    expect(draft).toMatch(/^In-Reply-To: <original@example\.invalid>$/m)
    expect(draft).toMatch(
      /^References: <root@example\.invalid> <original@example\.invalid>$/m
    )
    expect(draft).toContain(BODY_MARKER)
  })

  it("runs an approved send as one SMTP message from the assistant identity", async () => {
    const w = await world()
    const id = w.propose(
      sample("email.send", {
        to: ["guest@example.invalid"],
        cc: ["copy@example.invalid"],
        subject: "Hello",
        body: BODY_MARKER,
      })
    )
    approve(w, id)
    const result = await w.run(id)
    expect(result).toMatchObject({ ok: true })
    expect(w.fake.sent).toHaveLength(1)
    expect(w.fake.sent[0]?.from).toBe(USER)
    expect(w.fake.sent[0]?.to).toEqual([
      "guest@example.invalid",
      "copy@example.invalid",
    ])
    expect(w.fake.sent[0]?.data).toMatch(/^Subject: Hello$/m)
    expect(writes(w.fake)).toEqual([])
  })

  it("runs an approved reply-all to Reply-To, To and Cc minus the identity, in the thread", async () => {
    const w = await world()
    const id = w.propose(
      sample("email.reply", {
        messageId: "proton:INBOX:1700000001:7",
        replyAll: true,
        body: BODY_MARKER,
      })
    )
    approve(w, id)
    expect(await w.run(id)).toMatchObject({ ok: true })
    expect(w.fake.sent).toHaveLength(1)
    const mail = w.fake.sent[0]
    expect(mail?.from).toBe(USER)
    expect(mail?.to).toEqual([
      "desk@example.invalid",
      "owner@example.invalid",
      "carol@example.invalid",
    ])
    expect(mail?.data).toMatch(/^Subject: Re: Plans$/m)
    expect(mail?.data).toMatch(/^In-Reply-To: <original@example\.invalid>$/m)
    expect(writes(w.fake)).toEqual([])
  })

  it("runs an approved forward with the original attached unparsed", async () => {
    const w = await world()
    const id = w.propose(
      sample("email.forward", {
        messageId: "<original@example.invalid>",
        to: ["colleague@example.invalid"],
        note: BODY_MARKER,
      })
    )
    approve(w, id)
    expect(await w.run(id)).toMatchObject({ ok: true })
    const mail = w.fake.sent[0]
    expect(mail?.from).toBe(USER)
    expect(mail?.to).toEqual(["colleague@example.invalid"])
    expect(mail?.data).toMatch(/^Subject: Fwd: Plans$/m)
    expect(mail?.data).toMatch(
      /^Content-Type: message\/rfc822; name=forwarded\.eml$/m
    )
    expect(mail?.data).toContain("Message-ID: <original@example.invalid>")
    expect(writes(w.fake)).toEqual([])
  })

  it("runs an approved trash as one UID MOVE to Trash and sends nothing", async () => {
    const w = await world()
    const id = w.propose(
      sample("email.trash", { messageIds: ["<original@example.invalid>"] })
    )
    approve(w, id)
    expect(await w.run(id)).toEqual({
      ok: true,
      upstreamRef: null,
      result: { moved: 1 },
    })
    expect(writes(w.fake)).toEqual(["UID MOVE 7 Trash"])
    expect(w.fake.mailboxes.get("INBOX")?.messages).toEqual([])
    expect(w.fake.mailboxes.get("Trash")?.messages.map((m) => m.raw)).toEqual([
      original,
    ])
    expect(w.fake.smtpCommands).toEqual([])
  })

  it("records each execution in the audit log, with no message content", async () => {
    const w = await world()
    const id = w.propose(sample("email.send", { body: BODY_MARKER }))
    approve(w, id)
    await w.run(id)
    const rows = auditRows(w.db).filter((row) => row.target === id)
    expect(rows.map((row) => row.action).slice(-2)).toEqual([
      "execute.started",
      "execute",
    ])
    expect(loggedText(w.db)).not.toContain(BODY_MARKER)
    expect(loggedText(w.db)).not.toContain(PASSWORD)
  })

  it("runs nothing for an approval-tier intent without a signed approval", async () => {
    const w = await world()
    const id = w.propose(sample("email.send"))
    w.db.prepare("UPDATE intents SET state='approved' WHERE id=?").run(id)
    expect(await w.run(id)).toEqual({ ok: false, code: "missing_approval" })
    expect(w.fake.imapCommands).toEqual([])
    expect(w.fake.smtpCommands).toEqual([])
  })

  it("runs nothing for a pending intent", async () => {
    const w = await world()
    const id = w.propose(sample("email.trash"))
    expect(await w.run(id)).toEqual({ ok: false, code: "invalid_state" })
    expect(w.fake.imapCommands).toEqual([])
  })

  it("runs nothing when the approved payload was changed after signing", async () => {
    const w = await world()
    const id = w.propose(
      sample("email.send", { to: ["guest@example.invalid"] })
    )
    approve(w, id)
    const changed = sample("email.send", { to: ["attacker@example.invalid"] })
    w.db
      .prepare("UPDATE intents SET payload_json=? WHERE id=?")
      .run(canonicalize(changed), id)
    expect(await w.run(id)).toEqual({ ok: false, code: "hash_mismatch" })
    expect(w.fake.imapCommands).toEqual([])
    expect(w.fake.smtpCommands).toEqual([])
  })

  it("runs nothing when the bound connector is not the password-auth Proton manifest", async () => {
    const w = await world({
      ...protonManifest(),
      auth: { type: "oauth2", scopes: ["write"] },
    })
    const id = w.propose(sample("email.draft"))
    expect(await w.run(id)).toEqual({ ok: false, code: "hash_mismatch" })
    expect(w.fake.imapCommands).toEqual([])
  })

  it("runs nothing when another connector is bound to the Bridge kinds", async () => {
    const w = await world(protonManifest("mail"))
    const id = w.propose(sample("email.draft"))
    expect(await w.run(id)).toEqual({ ok: false, code: "hash_mismatch" })
    expect(w.fake.imapCommands).toEqual([])
  })

  it("moves nothing when one of the messages to trash is not found", async () => {
    const w = await world()
    const id = w.propose(
      sample("email.trash", {
        messageIds: ["<original@example.invalid>", "<missing@example.invalid>"],
      })
    )
    approve(w, id)
    expect(await w.run(id)).toEqual({ ok: false, code: "upstream_error" })
    expect(writes(w.fake)).toEqual([])
    expect(w.fake.mailboxes.get("INBOX")?.messages).toHaveLength(1)
  })

  it("sends nothing when the message replied to is not found", async () => {
    const w = await world()
    const id = w.propose(
      sample("email.reply", { messageId: "<missing@example.invalid>" })
    )
    approve(w, id)
    expect(await w.run(id)).toEqual({ ok: false, code: "upstream_error" })
    expect(w.fake.smtpCommands).toEqual([])
  })
})

describe("bridgeTransport", () => {
  const request = (overrides: Partial<WriteRequest>): WriteRequest => ({
    method: "POST",
    url: "bridge:smtp/send",
    body: canonicalize(sample("email.send")),
    connector: PROTON_CONNECTOR,
    operation: "send",
    intentKind: "email.send",
    idempotencyKey: "intent-1",
    ...overrides,
  })
  const unused = createProtonBridge({
    config: {
      host: "127.0.0.1",
      imapPort: 1,
      smtpPort: 1,
      tls: "none",
      allowSelfSigned: false,
      username: USER,
      searchFolders: ["INBOX"],
    },
    vault: new InMemoryVault(),
  })

  it.each([
    ["another connector", { connector: "mail" }],
    ["another destination", { url: "bridge:imap/append-draft" }],
    ["another method", { method: "PUT" }],
    [
      "a kind that does not match the body",
      { intentKind: "email.reply" as const },
    ],
    [
      "a kind Bridge does not run",
      {
        body: canonicalize(sample("email.label")),
        intentKind: "email.label" as const,
      },
    ],
    [
      "a body that is not an intent",
      { body: canonicalize({ kind: "email.send" }) },
    ],
  ])("refuses %s before touching Bridge", async (_name, overrides) => {
    await expect(
      bridgeTransport(unused)(request(overrides))
    ).rejects.toMatchObject({
      code: "bridge_error",
    })
  })
})

describe("reply helpers", () => {
  const found = (fields: Partial<FoundMessage>): FoundMessage => ({
    folder: "INBOX",
    uid: 1,
    raw: Buffer.alloc(0),
    messageId: undefined,
    references: undefined,
    subject: undefined,
    from: [{ address: "sender@example.invalid" }],
    replyTo: [],
    to: [],
    cc: [],
    ...fields,
  })

  it("replies to From when there is no Reply-To", () => {
    expect(replyRecipients(found({}), false, USER)).toEqual({
      to: ["sender@example.invalid"],
      cc: [],
    })
  })

  it("replies to the others when the identity wrote the original", () => {
    const own = found({
      from: [{ address: "Assistant@Example.invalid" }],
      to: [{ address: "guest@example.invalid" }],
      cc: [{ address: "guest@example.invalid" }, { name: "No address" }],
    })
    expect(replyRecipients(own, true, USER)).toEqual({
      to: ["guest@example.invalid"],
      cc: [],
    })
    expect(replyRecipients(own, false, USER)).toEqual({ to: [], cc: [] })
  })

  it("adds a prefix once", () => {
    expect(prefixed("Re", "Plans")).toBe("Re: Plans")
    expect(prefixed("Re", "RE: Plans")).toBe("RE: Plans")
    expect(prefixed("Fwd", "Fw: Plans")).toBe("Fw: Plans")
    expect(prefixed("Fwd", undefined)).toBe("Fwd:")
  })
})
