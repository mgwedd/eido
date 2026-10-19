import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { DatabaseSync } from "node:sqlite"
import type { IntentClient } from "@eido/gate"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { getCursor, openIndex } from "../../index"
import { resolveConfig } from "./config"
import type { ProtonConfig } from "./config"
import { endpointFor, openSocket } from "./connection"
import type { ConnectionFactory } from "./connection"
import { createProtonFacade } from "./facade"
import {
  ASSISTANT,
  FakeBridge,
  TEST_PASSWORD,
  bridgeFactory,
  message,
} from "./fake-bridge.test-support"
import { connectImap } from "./imap-client"
import { parseMessage } from "./mime"
import { sendMail } from "./smtp-client"
import { syncFolder } from "./sync"

let bridge: FakeBridge
let db: DatabaseSync
let config: ProtonConfig

beforeEach(async () => {
  bridge = new FakeBridge()
  await bridge.start()
  db = openIndex(":memory:")
  config = resolveConfig({
    username: ASSISTANT,
    host: bridge.host,
    imapPort: bridge.imapPort,
    smtpPort: bridge.smtpPort,
    imapTls: "none",
    smtpTls: "none",
    allowSelfSigned: false,
    batchSize: 2,
    timeoutMs: 2000,
    folders: ["INBOX"],
  })
})

afterEach(async () => {
  await bridge.stop()
})

const factory = bridgeFactory()

async function sync(folder = "INBOX") {
  const client = await connectImap(factory, config)
  try {
    return await syncFolder(db, client, folder, config.batchSize)
  } finally {
    await client.close()
  }
}

const documents = (): number =>
  Number(db.prepare("SELECT count(*) AS n FROM documents").get()?.["n"] ?? 0)

const plain = { to: ["a@example.com"], subject: "s", text: "t" }

describe("IMAP session", () => {
  test("lists folders and reads UIDVALIDITY and UIDNEXT on every select", async () => {
    bridge.addFolder("INBOX", 11, [message("a"), message("b")])
    bridge.addFolder("Folders/Work", 22)
    const client = await connectImap(factory, config)
    expect(await client.listFolders()).toEqual(["INBOX", "Folders/Work"])
    expect(await client.select("INBOX")).toEqual({
      name: "INBOX",
      uidvalidity: "11",
      uidnext: 3,
    })
    const folder = bridge.folders.get("INBOX")
    if (folder !== undefined) folder.uidvalidity = 12
    expect((await client.select("INBOX")).uidvalidity).toBe("12")
    await expect(client.select("Nope")).rejects.toMatchObject({
      code: "protocol_error",
    })
    await client.close()
  })

  test("fetches a UID range, headers only, and one message", async () => {
    bridge.addFolder("INBOX", 1, [message("a"), message("b"), message("c")])
    const client = await connectImap(factory, config)
    await client.select("INBOX")
    const range = await client.fetchRange(2, 3)
    expect(range.map((m) => m.uid)).toEqual([2, 3])
    expect(parseMessage(range[0]?.raw ?? Buffer.alloc(0)).messageId).toBe(
      "<b@example.com>"
    )
    const headers = (await client.fetchHeaders(1, 1))[0]?.raw.toString() ?? ""
    expect(headers).toContain("Subject: Subject a")
    expect(headers).not.toContain("Body of a")
    expect((await client.fetchOne(3))?.toString()).toContain("Body of c")
    expect(await client.fetchOne(9)).toBeUndefined()
    expect(await client.searchMessageId("<c@example.com>")).toEqual([3])
    expect(await client.searchMessageId("<zzz@example.com>")).toEqual([])
    await client.close()
  })

  test("reads use peeking commands only", async () => {
    bridge.addFolder("INBOX", 1, [message("a")])
    await sync()
    const fetches = bridge.imapCommands.filter((c) => c.startsWith("UID FETCH"))
    expect(fetches).toEqual(["UID FETCH 1:1 (UID BODY.PEEK[])"])
  })
})

describe("errors #24 can count", () => {
  test("a refused connection raises handshake_failed", async () => {
    await bridge.stop()
    await expect(connectImap(factory, config)).rejects.toMatchObject({
      name: "HandshakeFailedError",
      code: "handshake_failed",
    })
    await expect(sendMail(factory, config, plain)).rejects.toMatchObject({
      code: "handshake_failed",
    })
  })

  test("a server that is not Bridge (bad greeting) raises handshake_failed", async () => {
    const wrongPort: ConnectionFactory = async (endpoint) => {
      const socket = await openSocket({ ...endpoint, port: bridge.smtpPort })
      return {
        ...socket,
        authenticate: () => Promise.resolve({ ok: true, text: "" }),
      }
    }
    await expect(connectImap(wrongPort, config)).rejects.toMatchObject({
      code: "handshake_failed",
    })
  })

  test("a server that never answers raises handshake_failed after the timeout", async () => {
    const quiet = createServer(() => undefined)
    await new Promise<void>((resolve) =>
      quiet.listen(0, "127.0.0.1", () => resolve())
    )
    const slow = {
      ...config,
      imapPort: (quiet.address() as AddressInfo).port,
      timeoutMs: 50,
    }
    await expect(connectImap(factory, slow)).rejects.toMatchObject({
      code: "handshake_failed",
    })
    quiet.close()
  })

  test("a wrong password raises auth_failed on IMAP and SMTP, one attempt each, no retry", async () => {
    bridge.addFolder("INBOX", 1)
    const wrong = bridgeFactory("not-the-password")
    await expect(connectImap(wrong, config)).rejects.toMatchObject({
      name: "AuthFailedError",
      code: "auth_failed",
    })
    expect(
      bridge.imapCommands.filter((c) => c.startsWith("LOGIN"))
    ).toHaveLength(1)
    await expect(sendMail(wrong, config, plain)).rejects.toMatchObject({
      code: "auth_failed",
    })
    expect(bridge.deliveries).toHaveLength(0)
    expect(bridge.smtpConnections).toBe(1)
  })

  test("STARTTLS without a way to upgrade is a handshake failure", async () => {
    const tls = { ...config, imapTls: "starttls", smtpTls: "starttls" } as const
    await expect(connectImap(factory, tls)).rejects.toMatchObject({
      code: "handshake_failed",
    })
    await expect(sendMail(factory, tls, plain)).rejects.toMatchObject({
      code: "handshake_failed",
    })
  })

  test("endpoints carry host, port and username, and no password", () => {
    expect(endpointFor(config, "imap")).toEqual({
      protocol: "imap",
      host: bridge.host,
      port: bridge.imapPort,
      tls: "none",
      username: ASSISTANT,
      allowSelfSigned: false,
      timeoutMs: 2000,
    })
    expect(endpointFor(config, "smtp").port).toBe(bridge.smtpPort)
  })

  test("a STARTTLS upgrade against a server without TLS fails as a handshake failure", async () => {
    const socket = await openSocket({
      ...endpointFor(config, "imap"),
      tls: "starttls",
    })
    await expect(socket.upgradeTls?.()).rejects.toMatchObject({
      code: "handshake_failed",
    })
    socket.stream.destroy()
  })

  test("implicit TLS against a plain server fails as a handshake failure", async () => {
    await expect(
      openSocket({ ...endpointFor(config, "imap"), tls: "implicit" })
    ).rejects.toMatchObject({ code: "handshake_failed" })
  })
})

describe("sync", () => {
  test("stores messages as documents keyed by content hash with the Message-ID as source_ref", async () => {
    bridge.addFolder("INBOX", 5, [
      message("a", { subject: "Quarterly plan", body: "Budget notes" }),
      message("b"),
      message("c"),
    ])
    expect(await sync()).toEqual({
      folder: "INBOX",
      inserted: 3,
      skipped: 0,
      resynced: false,
    })
    const row = db
      .prepare(
        `SELECT d.source, d.mime, t.title, t.body, t.occurred_at
         FROM documents d JOIN document_text t USING (sha256) WHERE d.source_ref = '<a@example.com>'`
      )
      .get()
    expect(row).toMatchObject({
      source: "proton",
      mime: "message/rfc822",
      title: "Quarterly plan",
      body: "Budget notes",
      occurred_at: "2026-10-05T10:00:00.000Z",
    })
    expect(getCursor(db, "proton", "INBOX")).toEqual({
      cursor: "3",
      uidvalidity: "5",
    })
  })

  test("fetches in bounded batches", async () => {
    bridge.addFolder("INBOX", 5, [
      message("a"),
      message("b"),
      message("c"),
      message("d"),
      message("e"),
    ])
    await sync()
    const ranges = bridge.imapCommands
      .filter((c) => c.startsWith("UID FETCH"))
      .map((c) => /FETCH (\d+:\d+)/.exec(c)?.[1])
    expect(ranges).toEqual(["1:2", "3:4", "5:5"])
  })

  test("a second sync with nothing new fetches nothing and adds nothing", async () => {
    bridge.addFolder("INBOX", 5, [message("a"), message("b")])
    await sync()
    const before = bridge.imapCommands.length
    expect(await sync()).toMatchObject({ inserted: 0, skipped: 0 })
    expect(
      bridge.imapCommands.slice(before).some((c) => c.startsWith("UID FETCH"))
    ).toBe(false)
    expect(documents()).toBe(2)
  })

  test("picks up only the new messages after the cursor", async () => {
    bridge.addFolder("INBOX", 5, [message("a")])
    await sync()
    const folder = bridge.folders.get("INBOX")
    folder?.messages.push({ uid: 2, raw: message("b") })
    if (folder !== undefined) folder.uidnext = 3
    expect(await sync()).toMatchObject({ inserted: 1 })
    expect(documents()).toBe(2)
  })

  test("a sync interrupted mid-batch resumes from the stored UID cursor without duplicates", async () => {
    bridge.addFolder("INBOX", 5, [
      message("a"),
      message("b"),
      message("c"),
      message("d"),
      message("e"),
    ])
    bridge.dropOnFetch = 2
    await expect(sync()).rejects.toMatchObject({ code: "handshake_failed" })
    expect(getCursor(db, "proton", "INBOX")?.cursor).toBe("2")
    expect(documents()).toBe(2)
    expect(await sync()).toMatchObject({ inserted: 3, resynced: false })
    expect(documents()).toBe(5)
    const refs = db.prepare("SELECT source_ref FROM documents").all()
    expect(new Set(refs.map((r) => r["source_ref"])).size).toBe(5)
  })

  test("a changed UIDVALIDITY discards the cursor, resyncs the whole folder and creates no duplicates", async () => {
    bridge.addFolder("INBOX", 5, [message("a"), message("b"), message("c")])
    await sync()
    // The server renumbers: the same mail under new UIDs, plus one new message.
    bridge.addFolder("INBOX", 6, [
      message("a"),
      message("b"),
      message("c"),
      message("d"),
    ])
    bridge.imapCommands.length = 0
    expect(await sync()).toEqual({
      folder: "INBOX",
      inserted: 1,
      skipped: 3,
      resynced: true,
    })
    expect(documents()).toBe(4)
    expect(getCursor(db, "proton", "INBOX")).toEqual({
      cursor: "4",
      uidvalidity: "6",
    })
    expect(
      bridge.imapCommands.filter((c) => c.startsWith("UID FETCH"))[0]
    ).toContain("1:2")
  })

  test("a resync interrupted partway resumes under the new UIDVALIDITY", async () => {
    bridge.addFolder("INBOX", 5, [message("a")])
    await sync()
    bridge.addFolder("INBOX", 6, [
      message("a"),
      message("b"),
      message("c"),
      message("d"),
    ])
    // Fetch 1 was the initial sync; drop the second fetch of the resync.
    bridge.dropOnFetch = 3
    await expect(sync()).rejects.toMatchObject({ code: "handshake_failed" })
    expect(getCursor(db, "proton", "INBOX")).toEqual({
      cursor: "2",
      uidvalidity: "6",
    })
    expect(await sync()).toMatchObject({ resynced: false, inserted: 2 })
    expect(documents()).toBe(4)
  })

  test("the same Message-ID in two folders is one document, even when the bytes differ", async () => {
    bridge.addFolder("INBOX", 1, [
      message("shared", { extra: "X-Label: inbox" }),
    ])
    bridge.addFolder("Folders/Work", 2, [
      message("shared", { extra: "X-Label: work" }),
    ])
    await sync("INBOX")
    expect(await sync("Folders/Work")).toMatchObject({
      inserted: 0,
      skipped: 1,
    })
    expect(documents()).toBe(1)
  })

  test("identical bytes in two folders are one document", async () => {
    const raw = message("same")
    bridge.addFolder("INBOX", 1, [raw])
    bridge.addFolder("Archive", 2, [raw])
    await sync("INBOX")
    expect(await sync("Archive")).toMatchObject({ inserted: 0, skipped: 1 })
  })

  test("a repeated Message-ID inside one batch is stored once", async () => {
    bridge.addFolder("INBOX", 1, [
      message("dup", { extra: "X-N: 1" }),
      message("dup", { extra: "X-N: 2" }),
    ])
    expect(await sync()).toMatchObject({ inserted: 1, skipped: 1 })
  })

  test("a message without a Message-ID gets a folder-scoped source_ref and dedupes by hash", async () => {
    const bare = "Subject: bare\r\n\r\nno id here\r\n"
    bridge.addFolder("INBOX", 3, [bare])
    await sync()
    expect(
      db.prepare("SELECT source_ref FROM documents").get()?.["source_ref"]
    ).toBe("proton:INBOX:3:1")
    bridge.addFolder("INBOX", 4, [bare])
    expect(await sync()).toMatchObject({
      inserted: 0,
      skipped: 1,
      resynced: true,
    })
  })

  test("an empty folder still records its UIDVALIDITY", async () => {
    bridge.addFolder("INBOX", 9)
    await sync()
    expect(getCursor(db, "proton", "INBOX")).toEqual({
      cursor: "0",
      uidvalidity: "9",
    })
    bridge.addFolder("INBOX", 10, [message("a")])
    expect(await sync()).toMatchObject({ resynced: true, inserted: 1 })
  })

  test("threads group by the first reference", async () => {
    bridge.addFolder("INBOX", 1, [
      message("root"),
      message("reply", {
        extra:
          "In-Reply-To: <root@example.com>\r\nReferences: <root@example.com>",
      }),
    ])
    await sync()
    const rows = db
      .prepare("SELECT thread_id FROM document_text ORDER BY message_id")
      .all()
    expect(rows.map((r) => r["thread_id"])).toEqual([
      "<root@example.com>",
      "<root@example.com>",
    ])
  })
})

describe("SMTP send", () => {
  test("sends from the configured assistant identity to every recipient, never from a caller's address", async () => {
    const result = await sendMail(factory, config, {
      to: ["a@example.com"],
      cc: ["Cc Person <c@example.com>"],
      bcc: ["b@example.com"],
      subject: "Hello",
      text: "First\r\n.dot line\r\nlast",
    })
    const [delivery] = bridge.deliveries
    expect(bridge.deliveries).toHaveLength(1)
    expect(delivery?.from).toBe(ASSISTANT)
    expect(delivery?.to).toEqual([
      "a@example.com",
      "c@example.com",
      "b@example.com",
    ])
    const parsed = parseMessage(Buffer.from(delivery?.data ?? ""))
    expect(parsed.from).toEqual([{ address: ASSISTANT }])
    expect(parsed.messageId).toBe(result.messageId)
    expect(parsed.text).toBe("First\r\n.dot line\r\nlast")
    expect(delivery?.data).not.toContain("b@example.com")

    // The request type has no sender; a smuggled one is ignored at runtime.
    await sendMail(factory, config, {
      ...plain,
      ...({ from: "ceo@example.com" } as object),
    })
    expect(bridge.deliveries[1]?.from).toBe(ASSISTANT)
    expect(
      parseMessage(Buffer.from(bridge.deliveries[1]?.data ?? "")).from
    ).toEqual([{ address: ASSISTANT }])
  })

  test("carries a text/calendar part, so the calendar connector (#21) can send invitations", async () => {
    await sendMail(factory, config, {
      to: ["guest@example.com"],
      subject: "Invitation",
      text: "You are invited",
      calendar: {
        method: "REQUEST",
        ics: "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR",
      },
    })
    const parsed = parseMessage(Buffer.from(bridge.deliveries[0]?.data ?? ""))
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0]).toMatchObject({ mime: "text/calendar" })
    expect(parsed.attachments[0]?.data.toString()).toContain("METHOD:REQUEST")
    expect(parsed.from).toEqual([{ address: ASSISTANT }])
  })

  test("refuses no recipients, a malformed recipient and an injected command, connecting to nothing", async () => {
    await expect(
      sendMail(factory, config, { ...plain, to: [] })
    ).rejects.toThrow(/no recipients/)
    await expect(
      sendMail(factory, config, { ...plain, to: ["not-an-address"] })
    ).rejects.toThrow(/not an address/)
    await expect(
      sendMail(factory, config, {
        ...plain,
        to: ["a@example.com>\r\nRCPT TO:<x@example.com"],
      })
    ).rejects.toThrow()
    expect(bridge.smtpConnections).toBe(0)
  })
})

describe("IMAP writes", () => {
  test("a draft is appended to Drafts and nothing is sent", async () => {
    bridge.addFolder("Drafts", 1)
    const client = await connectImap(factory, config)
    await client.appendDraft("Drafts", Buffer.from(message("draft1")))
    await client.close()
    expect(bridge.folders.get("Drafts")?.messages).toHaveLength(1)
    expect(bridge.deliveries).toHaveLength(0)
  })

  test("trash moves the message to Trash and issues no EXPUNGE or DELETE", async () => {
    bridge.addFolder("INBOX", 1, [message("a"), message("b")])
    bridge.addFolder("Trash", 2)
    const client = await connectImap(factory, config)
    await client.moveToTrash("INBOX", [1], "Trash")
    await client.close()
    expect(bridge.folders.get("INBOX")?.messages.map((m) => m.uid)).toEqual([2])
    expect(bridge.folders.get("Trash")?.messages).toHaveLength(1)
    expect(bridge.imapCommands.join("\n")).not.toMatch(
      /EXPUNGE|DELETE|\\Deleted|STORE/i
    )
  })

  test("a refused move is a protocol error", async () => {
    bridge.addFolder("INBOX", 1, [message("a")])
    const client = await connectImap(factory, config)
    await expect(
      client.moveToTrash("INBOX", [1], "NoTrash")
    ).rejects.toMatchObject({ code: "protocol_error" })
    await client.close()
  })
})

describe("facade", () => {
  function setup() {
    const proposals: unknown[] = []
    const intents = {
      propose: vi.fn((proposal: unknown) => {
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
      facade: createProtonFacade({ db, config, connect: factory, intents }),
    }
  }

  test("every write verb returns only an intent id and opens no connection, sends no SMTP, issues no IMAP command", async () => {
    const { facade, proposals } = setup()
    const receipts = [
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
    expect(receipts).toEqual([
      { intentId: "intent-1" },
      { intentId: "intent-2" },
      { intentId: "intent-3" },
      { intentId: "intent-4" },
      { intentId: "intent-5" },
    ])
    expect(
      proposals.map((p) => (p as { intent: { kind: string } }).intent.kind)
    ).toEqual([
      "email.draft",
      "email.send",
      "email.reply",
      "email.forward",
      "email.trash",
    ])
    expect(bridge.imapConnections).toBe(0)
    expect(bridge.smtpConnections).toBe(0)
    expect(bridge.imapCommands).toEqual([])
    expect(bridge.deliveries).toEqual([])
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

  test("search, get and thread answer from the local index", async () => {
    bridge.addFolder("INBOX", 1, [
      message("root", { subject: "Offsite", body: "Venue shortlist" }),
      message("re", {
        subject: "Re: Offsite",
        body: "Venue two",
        date: "Mon, 05 Oct 2026 11:00:00 +0000",
        extra:
          "In-Reply-To: <root@example.com>\r\nReferences: <root@example.com>",
      }),
      message("other", { subject: "Lunch", body: "Sandwiches" }),
    ])
    await sync()
    const { facade } = setup()
    expect(
      facade
        .mail_search({ text: "venue" })
        .map((h) => h.sourceRef)
        .sort()
    ).toEqual(["<re@example.com>", "<root@example.com>"])
    expect(facade.mail_search({ text: "sandwiches", limit: 1 })).toHaveLength(1)
    expect(facade.mail_get({ messageId: "<re@example.com>" })).toMatchObject({
      subject: "Re: Offsite",
      text: "Venue two",
      inReplyTo: "<root@example.com>",
      threadId: "<root@example.com>",
    })
    expect(facade.mail_get({ messageId: "<nope@example.com>" })).toBeUndefined()
    expect(
      facade
        .mail_thread({ messageId: "<re@example.com>" })
        .map((m) => m.messageId)
    ).toEqual(["<root@example.com>", "<re@example.com>"])
    expect(facade.mail_thread({ messageId: "<nope@example.com>" })).toEqual([])
  })

  test("attachment_text reads the attachment live; a non-text type has null text", async () => {
    const withAttachments = [
      "Subject: files",
      "Message-ID: <files@example.com>",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain",
      "",
      "see files",
      "--B",
      'Content-Type: text/csv; name="a.csv"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("x,y\n1,2\n").toString("base64"),
      "--B",
      'Content-Type: image/png; name="p.png"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("png").toString("base64"),
      "--B--",
      "",
    ].join("\r\n")
    bridge.addFolder("INBOX", 1, [message("first"), withAttachments])
    const { facade } = setup()
    const id = "<files@example.com>"
    expect(
      await facade.attachment_text({ messageId: id, attachmentIndex: 0 })
    ).toEqual({ filename: "a.csv", mime: "text/csv", text: "x,y\n1,2\n" })
    expect(
      await facade.attachment_text({
        messageId: id,
        attachmentIndex: 1,
        folder: "INBOX",
      })
    ).toEqual({ filename: "p.png", mime: "image/png", text: null })
    await expect(
      facade.attachment_text({ messageId: id, attachmentIndex: 5 })
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      facade.attachment_text({
        messageId: "<missing@example.com>",
        attachmentIndex: 0,
      })
    ).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("the Bridge password", () => {
  test("is not in the config, endpoints, errors, index rows or console output", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined)
    )
    bridge.addFolder("INBOX", 1, [message("a")])
    const wrongSecret = "wrong-but-recognisable-secret"
    const seen: string[] = [
      JSON.stringify(config),
      JSON.stringify(endpointFor(config, "imap")),
      JSON.stringify(endpointFor(config, "smtp")),
    ]
    await sync()
    const bad = bridgeFactory(wrongSecret)
    for (const attempt of [
      connectImap(bad, config),
      sendMail(bad, config, plain),
    ]) {
      await attempt.catch((error: Error) =>
        seen.push(String(error.stack), error.message)
      )
    }
    await sendMail(factory, config, plain)
    seen.push(
      JSON.stringify(db.prepare("SELECT * FROM document_text").all()),
      JSON.stringify(db.prepare("SELECT * FROM cursors").all()),
      ...spies.flatMap((spy) => spy.mock.calls.map((c) => JSON.stringify(c)))
    )
    for (const text of seen) {
      expect(text).not.toContain(TEST_PASSWORD)
      expect(text).not.toContain(wrongSecret)
    }
    // The login really happened, so the absence above is not an empty run.
    expect(bridge.imapCommands.some((c) => c.startsWith("LOGIN"))).toBe(true)
    for (const spy of spies) spy.mockRestore()
  })
})
