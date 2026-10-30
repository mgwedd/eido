import type { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { countMatches, getCursor, search } from "../../index/index"
import { countSearched } from "../../ask/ask"
import { packEntry } from "../../context/assemble"
import { openDataDb } from "../../ledger/db"
import { createProfileStore } from "../../profile/store"
import { EntityRequiredError } from "../ingest-entity"
import { createDriveClient } from "./client"
import { fakeDrive } from "./fake-drive.test-support"
import { syncDrive } from "./sync"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})
async function fixture() {
  const fake = await fakeDrive()
  cleanup.push(fake.close)
  const db = openDataDb(":memory:")
  cleanup.push(() => db.close())
  const profile = createProfileStore(db, { audit: () => Promise.resolve() })
  const entity = await profile.createEntity({
    kind: "personal",
    name: "Synthetic personal",
    tag: "ME",
  })
  await profile.assignAccount({
    connector: "drive",
    accountRef: "owner@example.invalid",
    entityId: entity.id,
  })
  return {
    fake,
    db,
    entity,
    profile,
    client: createDriveClient(fake.transport),
    account: { accountRef: "owner@example.invalid", entities: profile },
  }
}
function documents(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT source_ref, entity_id FROM documents WHERE source = 'drive' ORDER BY source_ref"
    )
    .all()
}
const one = {
  id: "one",
  name: "First",
  mimeType: "text/plain",
  text: "First body",
}
const two = {
  id: "two",
  name: "Second",
  mimeType: "application/vnd.google-apps.document",
  text: "Second body",
}

describe("Drive sync cursor", () => {
  it("shows only the current version across edit, removal, and restore", async () => {
    const f = await fixture()
    f.fake.files.set(one.id, { ...one, text: "oldmarker" })
    await syncDrive(f)
    const oldSha = String(
      f.db
        .prepare("SELECT sha256 FROM documents WHERE source_ref = 'one'")
        .get()?.["sha256"]
    )
    expect(
      search(f.db, { text: "oldmarker" }).map((hit) => hit.sha256)
    ).toEqual([oldSha])

    f.fake.files.set(one.id, { ...one, text: "newmarker" })
    f.fake.changes.set("end", {
      files: [one],
      newStartPageToken: "after-edit",
    })
    await syncDrive(f)
    expect(search(f.db, { text: "oldmarker" })).toEqual([])
    expect(countMatches(f.db, { text: "oldmarker" })).toBe(0)
    expect(countMatches(f.db, { text: "newmarker" })).toBe(1)
    expect(countSearched(f.db, { terms: [], wants: "find" })).toBe(1)
    expect(() => packEntry(f.db, oldSha, "[M1]", 3)).toThrow(
      "a pack entry is not in the index"
    )
    expect(
      f.db
        .prepare("SELECT count(*) AS n FROM documents WHERE source_ref = 'one'")
        .get()?.["n"]
    ).toBe(2)

    f.fake.files.delete(one.id)
    f.fake.changes.set("after-edit", {
      removed: [one.id],
      newStartPageToken: "after-remove",
    })
    await syncDrive(f)
    expect(search(f.db, { text: "newmarker" })).toEqual([])
    expect(countSearched(f.db, { terms: [], wants: "find" })).toBe(0)

    f.fake.files.set(one.id, { ...one, text: "restoredmarker" })
    f.fake.changes.set("after-remove", {
      files: [one],
      newStartPageToken: "after-restore",
    })
    await syncDrive(f)
    expect(countMatches(f.db, { text: "restoredmarker" })).toBe(1)
    expect(countMatches(f.db, { text: "oldmarker" })).toBe(0)
  })

  it("applies the last change for a file without fetching a removed file", async () => {
    const f = await fixture()
    f.fake.files.set(one.id, { ...one, text: "beforemarker" })
    await syncDrive(f)
    f.fake.files.delete(one.id)
    f.fake.changes.set("end", {
      files: [one],
      removed: [one.id],
      newStartPageToken: "after-remove",
    })
    await syncDrive(f)
    expect(countMatches(f.db, { text: "beforemarker" })).toBe(0)
    expect(getCursor(f.db, "drive", "files")?.cursor).toBe(
      '{"phase":"changes","token":"after-remove"}'
    )
    expect(
      f.fake.requests.filter(
        (request) => request.path === "/drive/v3/files/one"
      )
    ).toHaveLength(2)
  })

  it("resumes listing after a failed page, then replays changes without duplicate documents", async () => {
    const f = await fixture()
    f.fake.files.set(one.id, one)
    f.fake.files.set(two.id, two)
    f.fake.failures.add("/drive/v3/files?1")
    await expect(syncDrive(f)).rejects.toMatchObject({ code: "read_failed" })
    expect(getCursor(f.db, "drive", "files")?.cursor).toBe(
      '{"phase":"list","token":"start","page":"1"}'
    )
    expect(documents(f.db)).toEqual([
      { source_ref: "one", entity_id: f.entity.id },
    ])
    f.fake.changes.set("start", {
      files: [one, two],
      removed: ["removed"],
      newStartPageToken: "end",
    })
    expect(await syncDrive(f)).toEqual({ inserted: 1, skipped: 2 })
    expect(documents(f.db)).toEqual([
      { source_ref: "one", entity_id: f.entity.id },
      { source_ref: "two", entity_id: f.entity.id },
    ])
    expect(
      f.fake.requests.filter((request) =>
        request.path.endsWith("startPageToken")
      )
    ).toHaveLength(1)
    expect(getCursor(f.db, "drive", "files")?.cursor).toBe(
      '{"phase":"changes","token":"end"}'
    )
    f.fake.changes.set("end", { files: [one, two], newStartPageToken: "later" })
    expect(await syncDrive(f)).toEqual({ inserted: 0, skipped: 2 })
    expect(documents(f.db).map((row) => row["source_ref"])).toEqual([
      "one",
      "two",
    ])
  })
  it("commits each changes page and resumes the next page after failure", async () => {
    const f = await fixture()
    f.fake.files.set(one.id, one)
    f.fake.files.set(two.id, two)
    f.db
      .prepare(
        "INSERT INTO cursors(connector,stream,cursor,updated_at) VALUES ('drive','files',?,?)"
      )
      .run('{"phase":"changes","token":"start"}', new Date().toISOString())
    f.fake.changes.set("start", { files: [one], nextPageToken: "page2" })
    f.fake.changes.set("page2", { files: [two], newStartPageToken: "end" })
    f.fake.failures.add("/drive/v3/changes?page2")
    await expect(syncDrive(f)).rejects.toMatchObject({ code: "read_failed" })
    expect(getCursor(f.db, "drive", "files")?.cursor).toBe(
      '{"phase":"changes","token":"page2"}'
    )
    expect(countMatches(f.db, { text: "First" })).toBe(1)
    expect(countMatches(f.db, { text: "Second" })).toBe(0)
    expect(await syncDrive(f)).toEqual({ inserted: 1, skipped: 0 })
    expect(countMatches(f.db, { text: "Second" })).toBe(1)
    expect(documents(f.db).map((row) => row["source_ref"])).toEqual([
      "one",
      "two",
    ])
    expect(
      f.fake.requests.filter(
        (request) =>
          request.path === "/drive/v3/changes" &&
          request.query.get("pageToken") === "start"
      )
    ).toHaveLength(1)
  })
  it("captures a document added between initial listing and changes polling", async () => {
    const f = await fixture()
    f.fake.files.set(one.id, one)
    f.fake.changes.set("start", { files: [two], newStartPageToken: "end" })
    const client = createDriveClient((request) => {
      if (new URL(request.url).pathname === "/drive/v3/changes")
        f.fake.files.set(two.id, two)
      return f.fake.transport(request)
    })
    expect(await syncDrive({ ...f, client })).toEqual({
      inserted: 2,
      skipped: 0,
    })
    expect(f.fake.requests[0]?.path).toBe("/drive/v3/changes/startPageToken")
    expect(documents(f.db).map((row) => row["source_ref"])).toEqual([
      "one",
      "two",
    ])
  })
  it("does not advance a page when document retrieval fails", async () => {
    const f = await fixture()
    f.fake.files.set(one.id, one)
    f.fake.failures.add("/drive/v3/files/one?")
    await expect(syncDrive(f)).rejects.toMatchObject({ code: "read_failed" })
    expect(documents(f.db)).toEqual([])
    expect(getCursor(f.db, "drive", "files")?.cursor).toBe(
      '{"phase":"list","token":"start"}'
    )
    expect(await syncDrive(f)).toEqual({ inserted: 1, skipped: 0 })
  })
  it("skips unsupported formats, inherits the default entity, and refuses missing entities", async () => {
    const f = await fixture()
    f.fake.files.set("binary", {
      id: "binary",
      name: "Image",
      mimeType: "image/png",
    })
    f.fake.files.set(one.id, one)
    await f.profile.unassignAccount("drive", "owner@example.invalid")
    await f.profile.setDefaultEntityId(f.entity.id)
    expect(await syncDrive(f)).toEqual({ inserted: 1, skipped: 1 })
    expect(documents(f.db)).toEqual([
      { source_ref: "one", entity_id: f.entity.id },
    ])
    const missing = {
      ...f,
      account: {
        accountRef: "missing@example.invalid",
        entities: {
          entityForAccount: () => Promise.resolve(null),
          getDefaultEntityId: () => Promise.resolve(null),
        },
      },
    }
    await expect(syncDrive(missing)).rejects.toBeInstanceOf(EntityRequiredError)
  })
  it.each([
    "{}",
    '{"phase":"changes","token":1}',
    '{"phase":"list","token":"x","page":1}',
  ])("refuses corrupt stored cursor %s", async (value) => {
    const f = await fixture()
    f.db
      .prepare(
        "INSERT INTO cursors(connector,stream,cursor,updated_at) VALUES ('drive','files',?,?)"
      )
      .run(value, new Date().toISOString())
    await expect(syncDrive(f)).rejects.toMatchObject({
      code: "invalid_response",
    })
    expect(f.fake.requests).toEqual([])
  })
})
