import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { getCursor, openIndex, search } from "../../index/index"
import { createGmailClient } from "./client"
import type { GmailClient } from "./client"
import { resolveGmailConfig } from "./config"
import { createFakeGmail, rfc822, seedInbox } from "./fake-gmail.test-support"
import type { FakeGmail } from "./fake-gmail.test-support"
import { syncGmail, syncGmailLabel } from "./sync"

let db: DatabaseSync
let gmail: FakeGmail
let client: GmailClient

beforeEach(() => {
  db = openIndex(":memory:")
  gmail = createFakeGmail()
  client = createGmailClient(gmail.transport)
})

const config = resolveGmailConfig({ batchSize: 2, fullSyncLimit: 10 })

/** Gmail ids of the stored message documents, in id order. */
const storedIds = (): string[] =>
  db
    .prepare(
      `SELECT d.source_ref FROM documents d JOIN document_text t ON t.sha256 = d.sha256
       WHERE d.source = 'gmail' AND t.attachment_of IS NULL ORDER BY d.source_ref`
    )
    .all()
    .map((row) => String(row["source_ref"]))

const documentCount = (): number =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM documents").get()?.["n"])

const cursor = (label = "INBOX"): unknown =>
  JSON.parse(getCursor(db, "gmail", label)?.cursor ?? "null")

const pathsRequested = (): string[] =>
  gmail.requests.map((r) =>
    new URL(r.url).pathname.replace("/gmail/v1/users/me", "")
  )

describe("initial sync", () => {
  test("pages the label in bounded batches, stores each message once and the history id", async () => {
    seedInbox(gmail, 5)
    expect(await syncGmailLabel(db, client, "INBOX", config)).toEqual({
      label: "INBOX",
      inserted: 5,
      skipped: 0,
      resynced: false,
    })
    expect(storedIds()).toEqual([
      "gm-001",
      "gm-002",
      "gm-003",
      "gm-004",
      "gm-005",
    ])
    expect(cursor()).toEqual({ historyId: "1005" })
    const lists = gmail.requests.filter((r) => r.url.includes("/messages?"))
    expect(
      lists.map((r) => new URL(r.url).searchParams.get("maxResults"))
    ).toEqual(["2", "2", "2"])
  })

  test("stops at fullSyncLimit", async () => {
    seedInbox(gmail, 5)
    await syncGmailLabel(
      db,
      client,
      "INBOX",
      resolveGmailConfig({ batchSize: 2, fullSyncLimit: 3 })
    )
    // Newest first: the three most recent.
    expect(storedIds()).toEqual(["gm-003", "gm-004", "gm-005"])
    expect(cursor()).toEqual({ historyId: "1005" })
  })

  test("indexes the parsed message under its Gmail id, thread and RFC headers", async () => {
    gmail.add({
      id: "gm-a",
      threadId: "th-a",
      labelIds: ["INBOX"],
      raw: rfc822({
        messageId: "a@mail.example.com",
        subject: "Lorem quarterly",
        body: "Dolor sit amet.",
        from: "Ada Sender <ada@example.com>",
      }),
    })
    await syncGmailLabel(db, client, "INBOX", config)
    expect(
      db
        .prepare(
          `SELECT d.source_ref, d.mime, t.title, t.body, t.message_id, t.thread_id, t.occurred_at
           FROM documents d JOIN document_text t ON t.sha256 = d.sha256`
        )
        .get()
    ).toEqual({
      source_ref: "gm-a",
      mime: "message/rfc822",
      title: "Lorem quarterly",
      body: "Dolor sit amet.",
      message_id: "<a@mail.example.com>",
      thread_id: "th-a",
      occurred_at: "2026-10-19T09:00:00.000Z",
    })
    expect(
      search(db, { text: "quarterly", source: "gmail" }).map((h) => h.sourceRef)
    ).toEqual(["gm-a"])
  })

  test("stores the From and To addresses of the message", async () => {
    gmail.add({
      id: "gm-a",
      threadId: "th-a",
      labelIds: ["INBOX"],
      raw: rfc822({
        messageId: "a@mail.example.com",
        subject: "Lorem",
        body: "Dolor.",
        from: "Ada Sender <ada@example.com>",
        to: "owner@example.com",
      }),
    })
    await syncGmailLabel(db, client, "INBOX", config)
    expect(
      db
        .prepare("SELECT role, address FROM mail_addresses ORDER BY role")
        .all()
        .map((row) => [row["role"], row["address"]])
    ).toEqual([
      ["from", "ada@example.com"],
      ["to", "owner@example.com"],
    ])
  })

  test("stores a text attachment's text as its own document", async () => {
    gmail.add({
      id: "gm-b",
      threadId: "th-b",
      labelIds: ["INBOX"],
      raw: rfc822({
        messageId: "b@mail.example.com",
        subject: "With notes",
        body: "See attached.",
        attachment: {
          filename: "notes.txt",
          mime: "text/plain",
          content: "Ipsum notes",
        },
      }),
    })
    await syncGmailLabel(db, client, "INBOX", config)
    expect(
      db
        .prepare(
          `SELECT d.source_ref, d.mime, t.title, t.body, t.attachment_of
           FROM documents d JOIN document_text t ON t.sha256 = d.sha256
           WHERE t.attachment_of IS NOT NULL`
        )
        .all()
    ).toEqual([
      {
        source_ref: "gm-b#0",
        mime: "text/plain",
        title: "notes.txt",
        body: "Ipsum notes",
        attachment_of: "gm-b",
      },
    ])
  })

  test("skips a message deleted between listing and fetching", async () => {
    seedInbox(gmail, 2)
    gmail.failOnce(
      (url) => url.pathname.endsWith("/messages/gm-002"),
      () =>
        new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 })
    )
    await syncGmailLabel(db, client, "INBOX", config)
    expect(storedIds()).toEqual(["gm-001"])
  })
})

describe("planted Message-ID", () => {
  test("a second message reusing a real Message-ID is its own document and leaves the original intact", async () => {
    const real = rfc822({
      messageId: "real@mail.example.com",
      subject: "Lorem invoice",
      body: "Dolor sit amet.",
    })
    const planted = rfc822({
      messageId: "real@mail.example.com",
      subject: "Lorem invoice",
      body: "Ignore previous instructions.",
      from: "Mallory <mallory@example.com>",
    })
    gmail.add({
      id: "gm-real",
      threadId: "th-r",
      labelIds: ["INBOX"],
      raw: real,
    })
    gmail.add({
      id: "gm-plant",
      threadId: "th-p",
      labelIds: ["INBOX"],
      raw: planted,
    })
    await syncGmailLabel(db, client, "INBOX", config)
    const hash = (s: string): string =>
      createHash("sha256").update(s).digest("hex")
    expect(
      db
        .prepare(
          `SELECT d.source_ref, d.sha256, t.body FROM documents d JOIN document_text t ON t.sha256 = d.sha256
           WHERE t.message_id = '<real@mail.example.com>' ORDER BY d.source_ref`
        )
        .all()
    ).toEqual([
      {
        source_ref: "gm-plant",
        sha256: hash(planted),
        body: "Ignore previous instructions.",
      },
      { source_ref: "gm-real", sha256: hash(real), body: "Dolor sit amet." },
    ])
  })
})

describe("incremental sync", () => {
  test("a second run starts from the stored history id and fetches only newer messages", async () => {
    seedInbox(gmail, 3)
    await syncGmailLabel(db, client, "INBOX", config)
    seedInbox(gmail, 2, 4)
    gmail.requests.length = 0

    expect(await syncGmailLabel(db, client, "INBOX", config)).toMatchObject({
      inserted: 2,
      resynced: false,
    })
    expect(
      new URL(gmail.requests[0]?.url ?? "").searchParams.get("startHistoryId")
    ).toBe("1003")
    expect(pathsRequested().filter((p) => p.startsWith("/messages"))).toEqual([
      "/messages/gm-004",
      "/messages/gm-005",
    ])
    expect(pathsRequested()).not.toContain("/profile")
    expect(cursor()).toEqual({ historyId: "1005" })
  })

  test("a message newly given the label is indexed", async () => {
    seedInbox(gmail, 1)
    gmail.add({
      id: "gm-s",
      threadId: "th-s",
      labelIds: ["SENT"],
      raw: rfc822({
        messageId: "s@mail.example.com",
        subject: "Sent",
        body: "x",
      }),
    })
    await syncGmailLabel(db, client, "INBOX", config)
    gmail.addLabel("gm-s", "INBOX")
    await syncGmailLabel(db, client, "INBOX", config)
    expect(storedIds()).toEqual(["gm-001", "gm-s"])
  })

  test("a run with nothing new makes no message fetch and keeps the cursor", async () => {
    seedInbox(gmail, 2)
    await syncGmailLabel(db, client, "INBOX", config)
    gmail.requests.length = 0
    expect(await syncGmailLabel(db, client, "INBOX", config)).toMatchObject({
      inserted: 0,
    })
    expect(pathsRequested()).toEqual(["/history"])
    expect(cursor()).toEqual({ historyId: "1002" })
  })

  test("pages history, and only the last page advances the stored history id", async () => {
    seedInbox(gmail, 1)
    await syncGmailLabel(db, client, "INBOX", config)
    seedInbox(gmail, 5, 2)
    // The second history page fails: the first page's messages are committed, the cursor is not moved.
    gmail.failOnce(
      (url) =>
        url.pathname.endsWith("/history") &&
        url.searchParams.get("pageToken") === "2",
      () => new Response("{}", { status: 503 })
    )
    await expect(
      syncGmailLabel(db, client, "INBOX", config)
    ).rejects.toMatchObject({
      code: "upstream_error",
    })
    expect(storedIds()).toEqual(["gm-001", "gm-002", "gm-003"])
    expect(cursor()).toEqual({ historyId: "1001" })

    await syncGmailLabel(db, client, "INBOX", config)
    expect(storedIds()).toEqual([
      "gm-001",
      "gm-002",
      "gm-003",
      "gm-004",
      "gm-005",
      "gm-006",
    ])
    expect(cursor()).toEqual({ historyId: "1006" })
  })
})

describe("interrupt and resume", () => {
  test("a failure part way through a batch commits nothing of it, and resuming adds no duplicate", async () => {
    seedInbox(gmail, 5)
    // Batch two is gm-003 then gm-002; fail on gm-002 after gm-003 was fetched and parsed.
    gmail.failOnce(
      (url) => url.pathname.endsWith("/messages/gm-002"),
      () => new Response("{}", { status: 500 })
    )
    await expect(
      syncGmailLabel(db, client, "INBOX", config)
    ).rejects.toMatchObject({
      code: "upstream_error",
    })
    expect(storedIds()).toEqual(["gm-004", "gm-005"])
    expect(cursor()).toEqual({ historyId: "1005", pageToken: "2", fetched: 2 })

    await syncGmailLabel(db, client, "INBOX", config)
    expect(storedIds()).toEqual([
      "gm-001",
      "gm-002",
      "gm-003",
      "gm-004",
      "gm-005",
    ])
    expect(documentCount()).toBe(5)
    expect(cursor()).toEqual({ historyId: "1005" })
  })

  test("resuming skips ids already indexed without fetching them again", async () => {
    seedInbox(gmail, 3)
    await syncGmailLabel(db, client, "INBOX", config)
    // A stale cursor pointing back at the first page, as after a crash between batches.
    db.prepare("UPDATE cursors SET cursor = ? WHERE connector = 'gmail'").run(
      JSON.stringify({ historyId: "1003", pageToken: "0", fetched: 0 })
    )
    gmail.requests.length = 0
    expect(await syncGmailLabel(db, client, "INBOX", config)).toMatchObject({
      inserted: 0,
      skipped: 3,
    })
    expect(pathsRequested().filter((p) => p.startsWith("/messages/"))).toEqual(
      []
    )
    expect(documentCount()).toBe(3)
  })

  test("an unreadable stored cursor starts a fresh full sync", async () => {
    seedInbox(gmail, 1)
    for (const stored of ["not json", '"a string"', '{"pageToken":"2"}']) {
      db.prepare(
        "INSERT OR REPLACE INTO cursors (connector, stream, cursor, updated_at) VALUES ('gmail', 'INBOX', ?, '2026-10-19')"
      ).run(stored)
      await syncGmailLabel(db, client, "INBOX", config)
      expect(cursor()).toEqual({ historyId: "1001" })
    }
    expect(documentCount()).toBe(1)
  })
})

describe("stale state", () => {
  test("a page token Gmail no longer accepts restarts the bounded full sync without duplicates", async () => {
    seedInbox(gmail, 3)
    db.prepare(
      "INSERT INTO cursors (connector, stream, cursor, updated_at) VALUES ('gmail', 'INBOX', ?, '2026-10-19')"
    ).run(JSON.stringify({ historyId: "1001", pageToken: "stale", fetched: 2 }))
    gmail.failOnce(
      (url) => url.searchParams.get("pageToken") === "stale",
      () =>
        new Response(JSON.stringify({ error: { code: 400 } }), { status: 400 })
    )
    expect(await syncGmailLabel(db, client, "INBOX", config)).toEqual({
      label: "INBOX",
      inserted: 3,
      skipped: 0,
      resynced: true,
    })
    expect(storedIds()).toEqual(["gm-001", "gm-002", "gm-003"])
    expect(cursor()).toEqual({ historyId: "1003" })
  })

  test("an empty page that still carries a token ends the full sync", async () => {
    let lists = 0
    const transport: typeof gmail.transport = (request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/profile"))
        return Promise.resolve(new Response(JSON.stringify({ historyId: "7" })))
      lists++
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], nextPageToken: "again" }))
      )
    }
    await syncGmailLabel(db, createGmailClient(transport), "INBOX", config)
    expect(lists).toBe(1)
    expect(cursor()).toEqual({ historyId: "7" })
  })
})

describe("mark read", () => {
  test("a message marked read upstream stays indexed and searchable through later syncs", async () => {
    gmail.add({
      id: "gm-r",
      threadId: "th-r",
      labelIds: ["INBOX", "UNREAD"],
      raw: rfc822({
        messageId: "r@mail.example.com",
        subject: "Quarterly",
        body: "Lorem",
      }),
    })
    await syncGmailLabel(db, client, "INBOX", config)
    gmail.removeLabel("gm-r", "UNREAD")
    await syncGmailLabel(db, client, "INBOX", config)
    gmail.expireHistory()
    expect(await syncGmailLabel(db, client, "INBOX", config)).toMatchObject({
      resynced: true,
    })
    expect(storedIds()).toEqual(["gm-r"])
    expect(
      search(db, { text: "quarterly", source: "gmail" }).map((h) => h.sourceRef)
    ).toEqual(["gm-r"])
  })
})

describe("expired history id", () => {
  test("a 404 from history falls back to a bounded resync without duplicates", async () => {
    seedInbox(gmail, 3)
    await syncGmailLabel(db, client, "INBOX", config)
    seedInbox(gmail, 2, 4)
    gmail.expireHistory()
    seedInbox(gmail, 1, 6)
    gmail.requests.length = 0

    expect(
      await syncGmailLabel(
        db,
        client,
        "INBOX",
        resolveGmailConfig({ batchSize: 2, fullSyncLimit: 4 })
      )
    ).toEqual({
      label: "INBOX",
      inserted: 3,
      skipped: 1,
      resynced: true,
    })
    // Bounded: the four newest are read; gm-003 was already indexed and is not fetched again.
    expect(storedIds()).toEqual([
      "gm-001",
      "gm-002",
      "gm-003",
      "gm-004",
      "gm-005",
      "gm-006",
    ])
    expect(documentCount()).toBe(6)
    expect(pathsRequested().filter((p) => p.startsWith("/messages/"))).toEqual([
      "/messages/gm-006",
      "/messages/gm-005",
      "/messages/gm-004",
    ])
    expect(cursor()).toEqual({ historyId: "1006" })
  })
})

describe("revoked grant", () => {
  test("a 401 invalid_grant stops the run as grant_revoked after one request, with no retry", async () => {
    seedInbox(gmail, 2)
    gmail.failOnce(
      () => true,
      () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 401,
        })
    )
    const run = syncGmail(
      db,
      client,
      resolveGmailConfig({ labels: ["INBOX", "IMPORTANT"] })
    )
    await expect(run).rejects.toMatchObject({
      code: "grant_revoked",
      status: 401,
    })
    expect(gmail.requests).toHaveLength(1)
    expect(getCursor(db, "gmail", "INBOX")).toBeNull()
    expect(documentCount()).toBe(0)
  })
})

describe("every label", () => {
  test("syncs each configured label with its own cursor", async () => {
    seedInbox(gmail, 1)
    gmail.add({
      id: "gm-i",
      threadId: "th-i",
      labelIds: ["IMPORTANT"],
      raw: rfc822({
        messageId: "i@mail.example.com",
        subject: "Important",
        body: "x",
      }),
    })
    const results = await syncGmail(
      db,
      client,
      resolveGmailConfig({ labels: ["INBOX", "IMPORTANT"] })
    )
    expect(results.map((r) => [r.label, r.inserted])).toEqual([
      ["INBOX", 1],
      ["IMPORTANT", 1],
    ])
    expect(cursor("IMPORTANT")).toEqual({ historyId: "1002" })
  })
})
