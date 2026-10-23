import type { DatabaseSync } from "node:sqlite"
import { GateUnavailableError } from "@eido/gate"
import { beforeEach, describe, expect, test } from "vitest"
import { getCursor } from "../../index/index"
import { openDataDb } from "../../ledger/db"
import { createProfileStore } from "../../profile/store"
import type { ProfileStore } from "../../profile/store"
import type { Entity } from "../../profile/types"
import type { IngestAccount } from "../ingest-entity"
import { EntityRequiredError } from "../ingest-entity"
import { resolveConfig } from "./config"
import { AuthFailedError, HandshakeFailedError, ProtonError } from "./errors"
import { MemorySource, plainMessage, raw } from "./memory-source.test-support"
import { syncFolder, syncProton } from "./sync"

let db: DatabaseSync
let source: MemorySource

let profile: ProfileStore
let assigned: Entity
let account: IngestAccount

const ACCOUNT = "assistant@example.com"

beforeEach(async () => {
  // The ledger schema refuses a document without a known entity.
  db = openDataDb(":memory:")
  source = new MemorySource()
  profile = createProfileStore(db, { audit: () => Promise.resolve() })
  assigned = await profile.createEntity({
    kind: "personal",
    name: "Test Personal",
    tag: "ME",
  })
  await profile.assignAccount({
    connector: "proton",
    accountRef: ACCOUNT,
    entityId: assigned.id,
  })
  account = { accountRef: ACCOUNT, entities: profile }
})

const count = (sql: string): number =>
  Number(Object.values(db.prepare(sql).get() ?? { n: -1 })[0])
const messageIds = (): string[] =>
  db
    .prepare(
      "SELECT message_id FROM document_text WHERE message_id IS NOT NULL ORDER BY message_id"
    )
    .all()
    .map((r) => String(r["message_id"]))

const five = [1, 2, 3, 4, 5].map((n) => ({
  uid: n,
  raw: plainMessage(`m${n}`),
}))

describe("syncFolder", () => {
  test("reads in bounded UID batches and stores the cursor and UIDVALIDITY", async () => {
    source.addFolder("INBOX", "7", five)
    const result = await syncFolder(db, source, "INBOX", 2, account)
    expect(result).toEqual({
      folder: "INBOX",
      inserted: 5,
      skipped: 0,
      resynced: false,
    })
    expect(source.calls.filter((c) => c.startsWith("fetchRaw"))).toEqual([
      "fetchRaw INBOX 1 2",
      "fetchRaw INBOX 3 2",
      "fetchRaw INBOX 5 2",
    ])
    expect(getCursor(db, "proton", "INBOX")).toEqual({
      cursor: "5",
      uidvalidity: "7",
    })
    expect(messageIds()).toEqual([
      "<m1@example.com>",
      "<m2@example.com>",
      "<m3@example.com>",
      "<m4@example.com>",
      "<m5@example.com>",
    ])
  })

  test("a second sync with no new mail fetches nothing", async () => {
    source.addFolder("INBOX", "7", five)
    await syncFolder(db, source, "INBOX", 2, account)
    source.calls.length = 0
    expect(await syncFolder(db, source, "INBOX", 2, account)).toMatchObject({
      inserted: 0,
      skipped: 0,
    })
    expect(source.calls).toEqual(["folderState INBOX"])
  })

  test("new mail after the cursor is fetched from the next UID only", async () => {
    source.addFolder("INBOX", "7", five.slice(0, 3))
    await syncFolder(db, source, "INBOX", 10, account)
    source.addFolder("INBOX", "7", five)
    source.calls.length = 0
    expect(await syncFolder(db, source, "INBOX", 10, account)).toMatchObject({
      inserted: 2,
    })
    expect(source.calls).toEqual(["folderState INBOX", "fetchRaw INBOX 4 10"])
  })

  test("gaps in UIDs (expunged mail) advance the cursor past the gap", async () => {
    source.addFolder("INBOX", "7", [
      { uid: 2, raw: plainMessage("a") },
      { uid: 9, raw: plainMessage("b") },
    ])
    await syncFolder(db, source, "INBOX", 1, account)
    expect(getCursor(db, "proton", "INBOX")?.cursor).toBe("9")
    expect(messageIds()).toEqual(["<a@example.com>", "<b@example.com>"])
  })

  test("records oversized UIDs as durable placeholders with the cursor", async () => {
    source.addFolder("INBOX", "7", [
      { uid: 1, raw: plainMessage("a") },
      { uid: 3, raw: plainMessage("b") },
    ])
    source.skipUid("INBOX", 2)
    source.skipUid("INBOX", 4)

    expect(await syncFolder(db, source, "INBOX", 2, account)).toEqual({
      folder: "INBOX",
      inserted: 4,
      skipped: 2,
      resynced: false,
    })
    expect(source.calls.filter((c) => c.startsWith("fetchRaw"))).toEqual([
      "fetchRaw INBOX 1 2",
      "fetchRaw INBOX 3 2",
    ])
    expect(getCursor(db, "proton", "INBOX")).toEqual({
      cursor: "4",
      uidvalidity: "7",
    })
    expect(
      db
        .prepare(
          "SELECT source_ref, mime FROM documents WHERE mime = 'application/x-eido-proton-skipped' ORDER BY source_ref"
        )
        .all()
    ).toEqual([
      {
        source_ref: "proton:skipped:INBOX:7:2",
        mime: "application/x-eido-proton-skipped",
      },
      {
        source_ref: "proton:skipped:INBOX:7:4",
        mime: "application/x-eido-proton-skipped",
      },
    ])
    expect(messageIds()).toEqual(["<a@example.com>", "<b@example.com>"])
    expect(await syncFolder(db, source, "INBOX", 2, account)).toMatchObject({
      inserted: 0,
      skipped: 0,
    })
    expect(count("SELECT count(*) FROM documents")).toBe(4)
  })

  test("a page containing only oversized UIDs records a placeholder", async () => {
    source.addFolder("INBOX", "7")
    source.skipUid("INBOX", 9)

    expect(await syncFolder(db, source, "INBOX", 2, account)).toMatchObject({
      inserted: 1,
      skipped: 1,
    })
    expect(getCursor(db, "proton", "INBOX")?.cursor).toBe("9")
    expect(
      db.prepare("SELECT source_ref FROM documents").get()?.["source_ref"]
    ).toBe("proton:skipped:INBOX:7:9")
  })

  test("an empty folder still records its UIDVALIDITY", async () => {
    source.addFolder("Archive", "42")
    await syncFolder(db, source, "Archive", 5, account)
    expect(getCursor(db, "proton", "Archive")).toEqual({
      cursor: "0",
      uidvalidity: "42",
    })
  })

  test("a tail the source no longer holds moves the cursor to the end of the folder", async () => {
    source.addFolder("INBOX", "7", five.slice(0, 2))
    await syncFolder(db, source, "INBOX", 5, account)
    // UIDNEXT advanced (mail arrived and was expunged) but nothing is left to read.
    const folder = source.folders.get("INBOX")
    if (folder !== undefined) folder.uidNext = 9
    await syncFolder(db, source, "INBOX", 5, account)
    expect(getCursor(db, "proton", "INBOX")?.cursor).toBe("8")
  })

  test("the same file attached to two messages stays reachable from both", async () => {
    const withFile = (id: string) =>
      raw([
        `Message-ID: <${id}@example.com>`,
        "Subject: file",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        `body ${id}`,
        "--b",
        'Content-Type: text/csv; name="a.csv"',
        'Content-Disposition: attachment; filename="a.csv"',
        "",
        "x,y",
        "--b--",
      ])
    source.addFolder("INBOX", "1", [
      { uid: 1, raw: withFile("one") },
      { uid: 2, raw: withFile("two") },
    ])
    await syncFolder(db, source, "INBOX", 10, account)
    expect(
      count(
        "SELECT count(*) FROM document_text WHERE attachment_of IS NOT NULL"
      )
    ).toBe(2)
  })
})

describe("UIDVALIDITY change", () => {
  test("triggers a full folder resync and creates no duplicate documents", async () => {
    source.addFolder("INBOX", "7", five)
    await syncFolder(db, source, "INBOX", 2, account)
    const before = count("SELECT count(*) FROM documents")
    expect(before).toBe(5)

    source.renumber("INBOX", "8", 100)
    source.calls.length = 0
    const result = await syncFolder(db, source, "INBOX", 2, account)

    expect(result).toEqual({
      folder: "INBOX",
      inserted: 0,
      skipped: 5,
      resynced: true,
    })
    // The whole folder was read again from the start, in bounded batches.
    expect(source.calls.filter((c) => c.startsWith("fetchRaw"))).toEqual([
      "fetchRaw INBOX 1 2",
      "fetchRaw INBOX 102 2",
      "fetchRaw INBOX 104 2",
    ])
    expect(count("SELECT count(*) FROM documents")).toBe(5)
    expect(getCursor(db, "proton", "INBOX")).toEqual({
      cursor: "104",
      uidvalidity: "8",
    })
  })

  test("mail that arrived under the new UIDVALIDITY is added alongside the known mail", async () => {
    source.addFolder("INBOX", "7", five.slice(0, 2))
    await syncFolder(db, source, "INBOX", 10, account)
    source.renumber("INBOX", "8", 1)
    const folder = source.folders.get("INBOX")
    folder?.messages.push({ uid: 3, raw: plainMessage("new") })
    if (folder !== undefined) folder.uidNext = 4
    const result = await syncFolder(db, source, "INBOX", 10, account)
    expect(result).toMatchObject({ inserted: 1, skipped: 2, resynced: true })
    expect(messageIds()).toEqual([
      "<m1@example.com>",
      "<m2@example.com>",
      "<new@example.com>",
    ])
  })
})

describe("resuming", () => {
  test("a sync interrupted mid-batch resumes from the stored UID cursor and creates no duplicates", async () => {
    source.addFolder("INBOX", "7", five)
    // The third fetch (UIDs 5..) fails: batches 1-2 and 3-4 are committed, the cursor is at 4.
    source.failFetchOn = {
      call: 3,
      error: new GateUnavailableError("gate went away"),
    }
    await expect(
      syncFolder(db, source, "INBOX", 2, account)
    ).rejects.toMatchObject({
      code: "gate_unavailable",
    })
    expect(getCursor(db, "proton", "INBOX")?.cursor).toBe("4")
    expect(count("SELECT count(*) FROM documents")).toBe(4)

    source.calls.length = 0
    const result = await syncFolder(db, source, "INBOX", 2, account)
    expect(source.calls).toEqual(["folderState INBOX", "fetchRaw INBOX 5 2"])
    expect(result).toMatchObject({ inserted: 1, skipped: 0 })
    expect(messageIds()).toHaveLength(5)
    expect(count("SELECT count(*) FROM documents")).toBe(5)
  })

  test("a batch that fails to parse leaves the cursor where it was", async () => {
    source.addFolder("INBOX", "7", five.slice(0, 2))
    await syncFolder(db, source, "INBOX", 2, account)
    const folder = source.folders.get("INBOX")
    folder?.messages.push({ uid: 3, raw: plainMessage("c") })
    if (folder !== undefined) folder.uidNext = 4
    // Redeliver UID 3 as bytes the parser cannot take: a part count above its limit.
    const parts = Array.from({ length: 10_002 }, () => "--b\r\n\r\nx\r\n").join(
      ""
    )
    if (folder !== undefined)
      folder.messages[2] = {
        uid: 3,
        raw: new TextEncoder().encode(
          `Content-Type: multipart/mixed; boundary="b"\r\n\r\n${parts}--b--\r\n`
        ),
      }
    await expect(syncFolder(db, source, "INBOX", 2, account)).rejects.toThrow()
    expect(getCursor(db, "proton", "INBOX")?.cursor).toBe("2")
  })
})

describe("deduplication", () => {
  test("the same Message-ID in two folders yields one document", async () => {
    const shared = plainMessage("shared", { subject: "Both folders" })
    // Same Message-ID, different bytes: the content hashes differ, so only the Message-ID can dedupe.
    const reexported = plainMessage("shared", {
      subject: "Both folders",
      extra: ["X-Folder: Work"],
    })
    source.addFolder("INBOX", "1", [{ uid: 1, raw: shared }])
    source.addFolder("Work", "2", [{ uid: 1, raw: reexported }])
    const config = resolveConfig({
      username: "assistant@example.com",
      folders: ["INBOX", "Work"],
    })
    const results = await syncProton(db, source, config, profile)
    expect(results.map((r) => [r.folder, r.inserted, r.skipped])).toEqual([
      ["INBOX", 1, 0],
      ["Work", 0, 1],
    ])
    expect(messageIds()).toEqual(["<shared@example.com>"])
    expect(count("SELECT count(*) FROM documents")).toBe(1)
  })

  test("identical bytes in two folders yield one document", async () => {
    const shared = plainMessage("same")
    source.addFolder("INBOX", "1", [{ uid: 1, raw: shared }])
    source.addFolder("Work", "2", [{ uid: 4, raw: shared }])
    await syncFolder(db, source, "INBOX", 10, account)
    expect(await syncFolder(db, source, "Work", 10, account)).toMatchObject({
      inserted: 0,
      skipped: 1,
    })
    expect(count("SELECT count(*) FROM documents")).toBe(1)
  })

  test("the same Message-ID twice in one batch yields one document", async () => {
    source.addFolder("INBOX", "1", [
      { uid: 1, raw: plainMessage("dup") },
      { uid: 2, raw: plainMessage("dup", { extra: ["X-Copy: 2"] }) },
    ])
    expect(await syncFolder(db, source, "INBOX", 10, account)).toMatchObject({
      inserted: 1,
      skipped: 1,
    })
  })

  test("a message with no Message-ID is keyed by folder, UIDVALIDITY and UID", async () => {
    source.addFolder("INBOX", "9", [
      { uid: 3, raw: raw(["Subject: anonymous", "", "no id"]) },
    ])
    await syncFolder(db, source, "INBOX", 10, account)
    expect(
      db.prepare("SELECT source_ref FROM documents").get()?.["source_ref"]
    ).toBe("proton:INBOX:9:3")
  })
})

describe("typed failures", () => {
  const config = resolveConfig({
    username: "assistant@example.com",
    folders: ["INBOX", "Work"],
  })

  test("auth_failed surfaces typed, and the run stops after one source call", async () => {
    source.addFolder("INBOX", "1", five)
    source.addFolder("Work", "1", five)
    source.failAll = Object.assign(new Error("bad password"), {
      code: "auth_failed",
    })
    const error = await syncProton(db, source, config, profile).catch(
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(AuthFailedError)
    expect(error).toMatchObject({ code: "auth_failed" })
    expect(source.calls).toEqual(["folderState INBOX"])
  })

  test("handshake_failed surfaces typed", async () => {
    source.addFolder("INBOX", "1", five)
    source.failAll = Object.assign(new Error("tls"), {
      code: "handshake_failed",
    })
    const error = await syncFolder(db, source, "INBOX", 2, account).catch(
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(HandshakeFailedError)
    expect(error).toMatchObject({ code: "handshake_failed" })
  })

  test("GateUnavailableError surfaces typed, counted as gate_unavailable", async () => {
    source.addFolder("INBOX", "1", five)
    source.failAll = new GateUnavailableError("no socket")
    const error = await syncFolder(db, source, "INBOX", 2, account).catch(
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(ProtonError)
    expect(error).toMatchObject({
      code: "gate_unavailable",
      message: "no socket",
    })
  })

  test("an unrecognised failure passes through untouched", async () => {
    source.addFolder("INBOX", "1", five)
    const boom = Object.assign(new Error("boom"), { code: "other" })
    source.failAll = boom
    await expect(syncFolder(db, source, "INBOX", 2, account)).rejects.toBe(boom)
  })
})

describe("entity at ingestion", () => {
  const storedEntities = (): unknown[] =>
    db
      .prepare("SELECT DISTINCT entity_id FROM documents ORDER BY entity_id")
      .all()
      .map((row) => row["entity_id"])
  const withAttachment = raw([
    "From: Ada Example <ada@example.com>",
    "Subject: with attachment",
    "Message-ID: <att@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "lorem",
    "--b",
    "Content-Type: text/plain",
    'Content-Disposition: attachment; filename="a.txt"',
    "",
    "ipsum",
    "--b--",
  ])

  test("stores messages, attachments and oversized placeholders with the assigned entity", async () => {
    source.addFolder("INBOX", "7", [{ uid: 1, raw: withAttachment }])
    source.skipUid("INBOX", 2)
    await syncProton(
      db,
      source,
      resolveConfig({ username: ACCOUNT, folders: ["INBOX"] }),
      profile
    )
    expect(count("SELECT count(*) FROM documents")).toBe(3)
    expect(storedEntities()).toEqual([assigned.id])
  })

  test("uses the default entity when the account has no assignment", async () => {
    const fallback = await profile.createEntity({
      kind: "company",
      name: "Test Company",
      tag: "CO",
    })
    await profile.setDefaultEntityId(fallback.id)
    source.addFolder("INBOX", "7", five)
    await syncFolder(db, source, "INBOX", 10, {
      accountRef: "other@example.com",
      entities: profile,
    })
    expect(count("SELECT count(*) FROM documents")).toBe(5)
    expect(storedEntities()).toEqual([fallback.id])
  })

  test("with no assignment and no default entity it fails typed, stores nothing and keeps the cursor", async () => {
    source.addFolder("INBOX", "7", five.slice(0, 2))
    await syncFolder(db, source, "INBOX", 10, account)
    await profile.unassignAccount("proton", ACCOUNT)
    source.addFolder("INBOX", "7", five)
    source.calls.length = 0

    const run = syncProton(
      db,
      source,
      resolveConfig({ username: ACCOUNT }),
      profile
    )
    await expect(run).rejects.toBeInstanceOf(EntityRequiredError)
    await expect(run).rejects.toMatchObject({
      code: "entity_required",
      connector: "proton",
    })
    expect(source.calls).toEqual([])
    expect(count("SELECT count(*) FROM documents")).toBe(2)
    expect(getCursor(db, "proton", "INBOX")).toEqual({
      cursor: "2",
      uidvalidity: "7",
    })
  })
})
