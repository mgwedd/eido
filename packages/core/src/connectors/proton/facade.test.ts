import { createHash } from "node:crypto"
import type { IntentClient } from "@eido/gate"
import { validateIntent } from "@eido/schemas"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { openIndex } from "../../index/index"
import { createProtonFacade } from "./facade"
import { policyFor, protonManifest } from "./manifest"
import { resolveConfig } from "./config"
import { MemorySource, plainMessage, raw } from "./memory-source.test-support"
import { syncFolder } from "./sync"
import type { DatabaseSync } from "node:sqlite"

let db: DatabaseSync
let source: MemorySource

beforeEach(() => {
  db = openIndex(":memory:")
  source = new MemorySource()
})

function setup() {
  const proposals: { intent: { kind: string }; origin: string }[] = []
  const intents = {
    propose: vi.fn((proposal: { intent: { kind: string }; origin: string }) => {
      proposals.push(proposal)
      return Promise.resolve({
        id: `intent-${proposals.length}`,
        tier: "approval",
        state: "pending",
      })
    }),
  } as unknown as IntentClient
  return {
    proposals,
    facade: createProtonFacade({
      db,
      intents,
      identity: "assistant@example.com",
    }),
  }
}

const manifest = protonManifest(
  resolveConfig({ username: "assistant@example.com" })
)

describe("write verbs", () => {
  async function callAll(facade: ReturnType<typeof setup>["facade"]) {
    return [
      await facade.draft_create({
        to: ["a@example.com"],
        subject: "s",
        body: "b",
      }),
      await facade.send({ to: ["a@example.com"], subject: "s", body: "b" }),
      await facade.reply({
        messageId: "<a@example.com>",
        replyAll: false,
        body: "b",
      }),
      await facade.forward({
        messageId: "<a@example.com>",
        to: ["a@example.com"],
      }),
      await facade.trash({ messageIds: ["<a@example.com>"] }),
    ]
  }

  test("each returns only an intent id, and none makes a ProtonMailSource call", async () => {
    source.addFolder("INBOX", "1", [{ uid: 1, raw: plainMessage("a") }])
    const { facade } = setup()
    // The facade is not given the source, so a source call is impossible by construction; syncing
    // first proves the source is live and that the verbs add no calls to it.
    await syncFolder(db, source, "INBOX", 10)
    const before = [...source.calls]
    expect(await callAll(facade)).toEqual([
      { intentId: "intent-1" },
      { intentId: "intent-2" },
      { intentId: "intent-3" },
      { intentId: "intent-4" },
      { intentId: "intent-5" },
    ])
    expect(source.calls).toEqual(before)
  })

  test("draft creation yields an auto intent; send, reply, forward and trash yield approval intents", async () => {
    source.addFolder("INBOX", "1", [{ uid: 1, raw: plainMessage("a") }])
    await syncFolder(db, source, "INBOX", 10)
    const { facade, proposals } = setup()
    await callAll(facade)
    const tiers = proposals.map((p) => [
      p.intent.kind,
      manifest.operations.find((op) => op.intentKind === p.intent.kind)
        ?.defaultTier,
    ])
    expect(tiers).toEqual([
      ["email.draft", "auto"],
      ["email.send", "approval"],
      ["email.reply", "approval"],
      ["email.forward", "approval"],
      ["email.trash", "approval"],
    ])
    expect(policyFor(manifest, "draft_create")?.defaultTier).toBe("auto")
  })

  test("a proposal carries the origin and exactly the intent the caller gave", async () => {
    const { facade, proposals } = setup()
    await facade.trash({ messageIds: ["<a@example.com>"] })
    expect(proposals[0]).toEqual({
      intent: {
        kind: "email.trash",
        args: { messageIds: ["<a@example.com>"] },
      },
      origin: "reactive",
    })
  })

  test("an explicit origin is passed through", async () => {
    const proposals: unknown[] = []
    const facade = createProtonFacade({
      db,
      identity: "assistant@example.com",
      origin: "proactive",
      intents: {
        propose: (p: unknown) => {
          proposals.push(p)
          return Promise.resolve({ id: "i" })
        },
      } as unknown as IntentClient,
    })
    await facade.trash({ messageIds: ["<a@example.com>"] })
    expect(proposals[0]).toMatchObject({ origin: "proactive" })
  })
})

describe("reply and forward fill what the model cannot", () => {
  const sha = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex")
  const full = raw([
    "From: Ada Example <ada@example.com>",
    "Reply-To: Desk <Desk@example.com>",
    "To: Assistant <assistant@example.com>, Bob <bob@example.com>",
    "Cc: Carol <carol@example.com>, DESK@example.com",
    "Subject: Plan",
    "Message-ID: <full@example.com>",
    "Date: Mon, 05 Oct 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body",
  ])
  const lastIntent = (proposals: { intent: unknown }[]) =>
    proposals[proposals.length - 1]?.intent

  async function indexed() {
    source.addFolder("INBOX", "1", [
      { uid: 1, raw: full },
      { uid: 2, raw: plainMessage("a") },
      {
        uid: 3,
        raw: raw([
          "Message-ID: <nobody@example.com>",
          "Subject: x",
          "",
          "no addresses",
        ]),
      },
    ])
    await syncFolder(db, source, "INBOX", 10)
    return setup()
  }

  test("the hash is that of the raw bytes core indexed, never the model's", async () => {
    const { facade, proposals } = await indexed()
    await facade.reply({
      messageId: "<full@example.com>",
      replyAll: false,
      body: "b",
      // Model output can carry extra fields whatever the type says.
      ...{ messageSha256: "f".repeat(64), to: ["mallory@example.invalid"] },
    })
    expect(lastIntent(proposals)).toEqual({
      kind: "email.reply",
      args: {
        messageId: "<full@example.com>",
        messageSha256: sha(full),
        replyAll: false,
        to: ["Desk@example.com"],
        body: "b",
      },
    })
    await facade.forward({
      messageId: "<full@example.com>",
      to: ["dan@example.com"],
      note: "FYI",
      ...{ messageSha256: "f".repeat(64) },
    })
    expect(lastIntent(proposals)).toEqual({
      kind: "email.forward",
      args: {
        messageId: "<full@example.com>",
        messageSha256: sha(full),
        to: ["dan@example.com"],
        note: "FYI",
      },
    })
  })

  test("a plain reply goes to From when there is no Reply-To", async () => {
    const { facade, proposals } = await indexed()
    await facade.reply({
      messageId: "<a@example.com>",
      replyAll: false,
      body: "b",
    })
    expect(lastIntent(proposals)).toMatchObject({
      args: { to: ["ada@example.com"] },
    })
  })

  test("reply-all adds To and Cc minus the assistant and duplicates, with Cc apart, and the intent validates", async () => {
    const { facade, proposals } = await indexed()
    await facade.reply({
      messageId: "<full@example.com>",
      replyAll: true,
      body: "b",
    })
    const intent = lastIntent(proposals)
    expect(intent).toMatchObject({
      args: {
        to: ["Desk@example.com"],
        cc: ["bob@example.com", "carol@example.com"],
      },
    })
    expect(validateIntent(intent).ok).toBe(true)
  })

  test("an unknown message throws not_found and proposes nothing", async () => {
    const { facade, proposals } = await indexed()
    expect(() =>
      facade.reply({
        messageId: "<none@example.com>",
        replyAll: false,
        body: "b",
      })
    ).toThrow(expect.objectContaining({ code: "not_found" }))
    expect(() =>
      facade.forward({ messageId: "<none@example.com>", to: ["a@example.com"] })
    ).toThrow(expect.objectContaining({ code: "not_found" }))
    expect(proposals).toEqual([])
  })

  test("a message with no sender throws no_recipients and proposes nothing", async () => {
    const { facade, proposals } = await indexed()
    expect(() =>
      facade.reply({
        messageId: "<nobody@example.com>",
        replyAll: true,
        body: "b",
      })
    ).toThrow(expect.objectContaining({ code: "no_recipients" }))
    expect(proposals).toEqual([])
  })
})

describe("read verbs answer from the index", () => {
  const withAttachments = raw([
    "Message-ID: <att@example.com>",
    "Subject: Files",
    "Date: Mon, 05 Oct 2026 12:00:00 +0000",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "see files",
    "--b",
    'Content-Type: text/csv; name="menu.csv"',
    'Content-Disposition: attachment; filename="menu.csv"',
    "Content-Transfer-Encoding: base64",
    "",
    "aXRlbSxwcmljZQpzb3VwLDQK",
    "--b",
    "Content-Type: image/png",
    'Content-Disposition: attachment; filename="logo.png"',
    "Content-Transfer-Encoding: base64",
    "",
    "iVBORw0KGgo=",
    "--b--",
  ])

  async function synced() {
    source.addFolder("INBOX", "1", [
      {
        uid: 1,
        raw: plainMessage("root", {
          subject: "Offsite",
          body: "Venue shortlist",
        }),
      },
      {
        uid: 2,
        raw: plainMessage("re", {
          subject: "Re: Offsite",
          body: "Venue two",
          date: "Mon, 05 Oct 2026 11:00:00 +0000",
          extra: [
            "In-Reply-To: <root@example.com>",
            "References: <root@example.com>",
          ],
        }),
      },
      {
        uid: 3,
        raw: plainMessage("other", { subject: "Lunch", body: "Sandwiches" }),
      },
      { uid: 4, raw: withAttachments },
    ])
    await syncFolder(db, source, "INBOX", 10)
    source.calls.length = 0
    return setup().facade
  }

  test("mail_search finds by body text and honours the limit", async () => {
    const facade = await synced()
    expect(
      facade
        .mail_search({ text: "venue" })
        .map((h) => h.sourceRef)
        .sort()
    ).toEqual(["<re@example.com>", "<root@example.com>"])
    expect(facade.mail_search({ text: "venue", limit: 1 })).toHaveLength(1)
    expect(source.calls).toEqual([])
  })

  test("mail_get returns one message with its thread headers, or undefined", async () => {
    const facade = await synced()
    expect(facade.mail_get({ messageId: "<re@example.com>" })).toEqual({
      messageId: "<re@example.com>",
      subject: "Re: Offsite",
      text: "Venue two",
      occurredAt: "2026-10-05T11:00:00.000Z",
      threadId: "<root@example.com>",
      inReplyTo: "<root@example.com>",
    })
    expect(facade.mail_get({ messageId: "<nope@example.com>" })).toBeUndefined()
  })

  test("mail_thread returns the thread in order, and nothing for an unknown message", async () => {
    const facade = await synced()
    expect(
      facade
        .mail_thread({ messageId: "<re@example.com>" })
        .map((m) => m.messageId)
    ).toEqual(["<root@example.com>", "<re@example.com>"])
    expect(facade.mail_thread({ messageId: "<nope@example.com>" })).toEqual([])
  })

  test("attachment_text returns a text attachment's text and null for a non-text one", async () => {
    const facade = await synced()
    expect(
      facade.attachment_text({
        messageId: "<att@example.com>",
        attachmentIndex: 0,
      })
    ).toEqual({
      filename: "menu.csv",
      mime: "text/csv",
      text: "item,price\nsoup,4\n",
    })
    expect(
      facade.attachment_text({
        messageId: "<att@example.com>",
        attachmentIndex: 1,
      })
    ).toEqual({
      filename: "logo.png",
      mime: "image/png",
      text: null,
    })
    expect(source.calls).toEqual([])
  })

  test("attachment_text on a missing attachment or message is a not_found error", async () => {
    const facade = await synced()
    expect(() =>
      facade.attachment_text({
        messageId: "<att@example.com>",
        attachmentIndex: 5,
      })
    ).toThrow(expect.objectContaining({ code: "not_found" }))
    expect(() =>
      facade.attachment_text({
        messageId: "<nope@example.com>",
        attachmentIndex: 0,
      })
    ).toThrow(expect.objectContaining({ code: "not_found" }))
  })

  test("attachments are not listed as messages", async () => {
    const facade = await synced()
    expect(
      facade.mail_get({ messageId: "<att@example.com>#0" })
    ).toBeUndefined()
  })
})
