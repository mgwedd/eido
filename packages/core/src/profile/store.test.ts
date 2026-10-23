import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  GateRequestError,
  GateUnavailableError,
  createAuditClient,
} from "@eido/gate"
import { beforeEach, describe, expect, test } from "vitest"
import { MIGRATIONS, SCHEMA_VERSION, openIndex } from "../index/schema"
import { ProfileError, createProfileStore, readDefaultEntityId } from "./index"
import type { ProfileAuditEntry, ProfileStore } from "./index"
import { isIanaTimezone, normalizeAddress } from "./validate"

const OWNER = {
  displayName: "Test Owner",
  timezone: "Europe/Zurich",
  workingHours: { mon: { start: "09:00", end: "17:30" } },
  signature: "Test Owner",
  addresses: [{ address: "Owner@Example.test", label: "main" }],
}

let db: DatabaseSync
let audits: ProfileAuditEntry[]
let store: ProfileStore
let tick: number

beforeEach(() => {
  db = openIndex(":memory:")
  audits = []
  tick = 0
  store = createProfileStore(db, {
    audit: (entry) => {
      audits.push(entry)
      return Promise.resolve()
    },
    now: () => new Date(Date.UTC(2030, 0, 1, 0, 0, tick++)),
  })
})

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (error) {
    if (error instanceof ProfileError) return error.code
    throw error
  }
  return "none"
}

const count = (sql: string): number =>
  Number(db.prepare(sql).get()?.["n"] ?? -1)
const history = (): number => count("SELECT count(*) AS n FROM profile_history")
const tables = (database: DatabaseSync): string[] =>
  database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    )
    .all()
    .map((r) => String(r["name"]))

describe("migrations", () => {
  test("empty database and a database at the #19 schema end at the same version and tables", () => {
    const old = new DatabaseSync(":memory:")
    old.exec(MIGRATIONS[0] ?? "")
    old.exec("PRAGMA user_version = 1")
    expect(tables(old)).not.toContain("entities")
    const path = join(mkdtempSync(join(tmpdir(), "eido-profile-")), "data.db")
    const file = new DatabaseSync(path)
    file.exec(MIGRATIONS[0] ?? "")
    file.exec("PRAGMA user_version = 1")
    file.close()
    const upgraded = openIndex(path)
    expect(
      upgraded.prepare("PRAGMA user_version").get()?.["user_version"]
    ).toBe(SCHEMA_VERSION)
    expect(tables(upgraded)).toEqual(tables(db))
    upgraded.close()
    const again = openIndex(path)
    expect(tables(again)).toEqual(tables(db))
    expect(again.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
      SCHEMA_VERSION
    )
    again.close()
  })

  test("a failing migration rolls back and keeps the previous version", () => {
    expect(() => db.exec(MIGRATIONS[1] ?? "")).toThrow()
    expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
      SCHEMA_VERSION
    )
  })
})

describe("updateProfile", () => {
  test("first write needs displayName and timezone, then stores and normalizes", async () => {
    expect(await store.getProfile()).toBeNull()
    expect(await codeOf(() => store.updateProfile({ signature: "x" }))).toBe(
      "invalid"
    )
    const profile = await store.updateProfile(OWNER)
    expect(profile.addresses).toEqual([
      { address: "owner@example.test", label: "main" },
    ])
    expect(await store.getProfile()).toEqual(profile)
    expect(profile.updatedAt).toMatch(/^2030-01-01T00:00:\d\d\.000Z$/)
  })

  test("partial update keeps other fields and logs only changed fields", async () => {
    await store.updateProfile(OWNER)
    const before = history()
    await store.updateProfile({ signature: "Regards" })
    expect((await store.getProfile())?.timezone).toBe("Europe/Zurich")
    expect(history()).toBe(before + 1)
    await store.updateProfile({ signature: "Regards" })
    expect(history()).toBe(before + 1)
  })

  test.each([
    ["invalid timezone", { timezone: "Mars/Olympus" }],
    ["offset timezone", { timezone: "+01:00" }],
    ["malformed email", { addresses: [{ address: "not-an-email" }] }],
    [
      "duplicate email",
      {
        addresses: [
          { address: "a@example.test" },
          { address: "A@example.test" },
        ],
      },
    ],
    ["empty display name", { displayName: "" }],
    ["blank display name", { displayName: "   " }],
    [
      "end before start",
      { workingHours: { tue: { start: "17:00", end: "09:00" } } },
    ],
    ["bad time", { workingHours: { tue: { start: "9am", end: "17:00" } } }],
    ["unknown key", { password: "x" }],
  ])("rejects %s and leaves the data unchanged", async (_name, patch) => {
    await store.updateProfile(OWNER)
    const before = await store.getProfile()
    const rows = history()
    expect(await codeOf(() => store.updateProfile(patch))).toBe("invalid")
    expect(await store.getProfile()).toEqual(before)
    expect(history()).toBe(rows)
  })

  test("carries issues in details", async () => {
    try {
      await store.updateProfile({ displayName: "", timezone: "x/y" })
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileError)
      expect((error as ProfileError).details.length).toBeGreaterThan(0)
      return
    }
    throw new Error("expected failure")
  })

  test("validators", () => {
    expect(isIanaTimezone("UTC")).toBe(true)
    expect(isIanaTimezone("America/Argentina/Buenos_Aires")).toBe(true)
    expect(normalizeAddress(`${"a".repeat(250)}@example.test`)).toBeNull()
  })
})

describe("entities", () => {
  test("create, list, update, delete round trip with history and audit", async () => {
    const company = await store.createEntity({
      kind: "company",
      name: "Test Company",
      tag: "TC",
    })
    expect(company.id).toMatch(/^[0-9a-f-]{36}$/)
    await store.createEntity({
      kind: "property",
      name: "Test Property",
      tag: "TP",
    })
    expect((await store.listEntities()).map((e) => e.name)).toEqual([
      "Test Company",
      "Test Property",
    ])
    expect((await store.entityByTag("tc"))?.id).toBe(company.id)
    expect(await store.entityByTag("nope")).toBeNull()
    const renamed = await store.updateEntity(company.id, { name: "Test Co" })
    expect(renamed).toMatchObject({
      name: "Test Co",
      tag: "TC",
      kind: "company",
    })
    expect(await store.updateEntity(company.id, { name: "Test Co" })).toEqual(
      renamed
    )
    await store.deleteEntity(company.id)
    expect(await store.entityByTag("TC")).toBeNull()
    expect(history()).toBe(4)
    expect(audits.map((a) => a.action)).toEqual([
      "entity.create",
      "entity.create",
      "entity.update",
      "entity.delete",
    ])
  })

  test("rejects duplicate name and duplicate tag, case-insensitively, on create and update", async () => {
    const a = await store.createEntity({
      kind: "personal",
      name: "Alpha",
      tag: "A",
    })
    await store.createEntity({ kind: "personal", name: "Beta", tag: "B" })
    expect(
      await codeOf(() =>
        store.createEntity({ kind: "company", name: "alpha", tag: "Z" })
      )
    ).toBe("duplicate_name")
    expect(
      await codeOf(() =>
        store.createEntity({ kind: "company", name: "Zed", tag: "b" })
      )
    ).toBe("duplicate_tag")
    expect(await codeOf(() => store.updateEntity(a.id, { name: "BETA" }))).toBe(
      "duplicate_name"
    )
    expect(await codeOf(() => store.updateEntity(a.id, { tag: "B" }))).toBe(
      "duplicate_tag"
    )
    expect(await store.listEntities()).toHaveLength(2)
  })

  test.each([
    ["open bracket", "a[b"],
    ["close bracket", "a]b"],
    ["line feed", "a\nb"],
    ["carriage return", "a\rb"],
    ["too long", "x".repeat(25)],
    ["blank", "   "],
    ["empty", ""],
  ])("rejects a tag with %s", async (_name, tag) => {
    expect(
      await codeOf(() =>
        store.createEntity({ kind: "personal", name: "N", tag })
      )
    ).toBe("invalid")
    const e = await store.createEntity({
      kind: "personal",
      name: "Ok",
      tag: "ok",
    })
    expect(await codeOf(() => store.updateEntity(e.id, { tag }))).toBe(
      "invalid"
    )
    expect((await store.entityByTag("ok"))?.id).toBe(e.id)
  })

  test("accepts a tag of exactly 24 characters; rejects bad names and unknown kinds", async () => {
    await store.createEntity({
      kind: "personal",
      name: "Long",
      tag: "x".repeat(24),
    })
    expect(
      await codeOf(() =>
        store.createEntity({ kind: "personal", name: " \t ", tag: "t" })
      )
    ).toBe("invalid")
    expect(
      await codeOf(() =>
        store.createEntity({ kind: "cat", name: "C", tag: "c" })
      )
    ).toBe("invalid")
  })

  test("updateEntity and deleteEntity report a missing entity", async () => {
    expect(
      await codeOf(() => store.updateEntity("missing", { name: "x" }))
    ).toBe("not_found")
    expect(await codeOf(() => store.deleteEntity("missing"))).toBe("not_found")
  })

  test("a name with a quote and SQL round-trips as data", async () => {
    const name = `Bob's "Co"'; DROP TABLE entities; --`
    const created = await store.createEntity({
      kind: "company",
      name,
      tag: "bob",
    })
    expect((await store.listEntities())[0]?.name).toBe(name)
    expect((await store.entityByTag("bob"))?.id).toBe(created.id)
    expect(tables(db)).toContain("entities")
  })
})

describe("deleteEntity references", () => {
  test("blocked by an assignment, then by a document, then succeeds", async () => {
    const e = await store.createEntity({
      kind: "company",
      name: "Test Company",
      tag: "TC",
    })
    await store.assignAccount({
      connector: "mail",
      accountRef: "box-1",
      entityId: e.id,
    })
    let blocked: unknown
    try {
      await store.deleteEntity(e.id)
    } catch (error) {
      blocked = error
    }
    expect(blocked).toMatchObject({
      code: "entity_in_use",
      details: ["entity_assignments"],
    })
    await store.unassignAccount("mail", "box-1")

    db.prepare(
      "INSERT INTO documents (sha256, source, source_ref, mime, entity_id, ingested_at) VALUES ('h','s','r','text/plain',?, 't')"
    ).run(e.id)
    expect(await codeOf(() => store.deleteEntity(e.id))).toBe("entity_in_use")
    expect(await store.listEntities()).toHaveLength(1)

    const free = await store.createEntity({
      kind: "personal",
      name: "Free",
      tag: "F",
    })
    await store.deleteEntity(free.id)
    expect(await store.listEntities()).toHaveLength(1)
  })
})

describe("default entity", () => {
  test("is null until set; set saves and returns it, null clears it", async () => {
    const e = await store.createEntity({
      kind: "personal",
      name: "Me",
      tag: "ME",
    })
    expect(await store.getDefaultEntityId()).toBeNull()
    expect(await store.setDefaultEntityId(e.id)).toBe(e.id)
    expect(await store.getDefaultEntityId()).toBe(e.id)
    expect(readDefaultEntityId(db)).toBe(e.id)
    expect(await store.setDefaultEntityId(null)).toBeNull()
    expect(await store.getDefaultEntityId()).toBeNull()
  })

  test("moving the default replaces it and records each change in profile_history", async () => {
    const a = await store.createEntity({ kind: "company", name: "A", tag: "a" })
    const b = await store.createEntity({ kind: "company", name: "B", tag: "b" })
    await store.setDefaultEntityId(a.id)
    await store.setDefaultEntityId(a.id)
    await store.setDefaultEntityId(b.id)
    expect(await store.getDefaultEntityId()).toBe(b.id)
    expect(
      db
        .prepare(
          "SELECT old_json, new_json FROM profile_history WHERE field = 'profile.defaultEntityId' ORDER BY id"
        )
        .all()
        .map((r) => [r["old_json"], r["new_json"]])
    ).toEqual([
      [null, JSON.stringify(a.id)],
      [JSON.stringify(a.id), JSON.stringify(b.id)],
    ])
  })

  test("an unknown entity is refused and the default stays", async () => {
    const e = await store.createEntity({ kind: "company", name: "A", tag: "a" })
    await store.setDefaultEntityId(e.id)
    expect(await codeOf(() => store.setDefaultEntityId("missing"))).toBe(
      "not_found"
    )
    expect(await store.getDefaultEntityId()).toBe(e.id)
  })

  test("deleting the default entity is refused until the default moves", async () => {
    const e = await store.createEntity({ kind: "company", name: "A", tag: "a" })
    await store.setDefaultEntityId(e.id)
    let blocked: unknown
    try {
      await store.deleteEntity(e.id)
    } catch (error) {
      blocked = error
    }
    expect(blocked).toMatchObject({
      code: "entity_in_use",
      details: ["default_entity"],
    })
    expect(() =>
      db.prepare("DELETE FROM entities WHERE id = ?").run(e.id)
    ).toThrow("FOREIGN KEY constraint failed")
    await store.setDefaultEntityId(null)
    await store.deleteEntity(e.id)
    expect(await store.listEntities()).toEqual([])
  })
})

describe("assignments", () => {
  test("assignAccount moves an account rather than adding a second assignment", async () => {
    const a = await store.createEntity({ kind: "company", name: "A", tag: "a" })
    const b = await store.createEntity({
      kind: "property",
      name: "B",
      tag: "b",
    })
    expect(await store.entityForAccount("cal", "work")).toBeNull()
    await store.assignAccount({
      connector: "cal",
      accountRef: "work",
      entityId: a.id,
    })
    expect((await store.entityForAccount("cal", "work"))?.id).toBe(a.id)
    await store.assignAccount({
      connector: "cal",
      accountRef: "work",
      entityId: b.id,
    })
    expect((await store.entityForAccount("cal", "work"))?.id).toBe(b.id)
    expect(count("SELECT count(*) AS n FROM entity_assignments")).toBe(1)
    const rows = history()
    await store.assignAccount({
      connector: "cal",
      accountRef: "work",
      entityId: b.id,
    })
    expect(history()).toBe(rows)
  })

  test("rejects an unknown entity and a malformed assignment; unassign reports what happened", async () => {
    expect(
      await codeOf(() =>
        store.assignAccount({
          connector: "cal",
          accountRef: "w",
          entityId: "0".repeat(36),
        })
      )
    ).toBe("not_found")
    expect(await codeOf(() => store.assignAccount({ connector: "cal" }))).toBe(
      "invalid"
    )
    expect(await store.unassignAccount("cal", "w")).toBe(false)
  })
})

describe("audit", () => {
  test("each entity and assignment change appends one entry with hashes only", async () => {
    const e = await store.createEntity({
      kind: "company",
      name: "Secret Name",
      tag: "SECRETTAG",
    })
    await store.updateEntity(e.id, { tag: "OTHERTAG" })
    await store.assignAccount({
      connector: "mail",
      accountRef: "owner@example.test",
      entityId: e.id,
    })
    await store.unassignAccount("mail", "owner@example.test")
    await store.deleteEntity(e.id)
    expect(audits.map((a) => a.action)).toEqual([
      "entity.create",
      "entity.update",
      "account.assign",
      "account.unassign",
      "entity.delete",
    ])
    const serialized = JSON.stringify(audits)
    for (const clear of [
      "Secret Name",
      "SECRETTAG",
      "OTHERTAG",
      "mail",
      "owner@example.test",
      e.id,
    ]) {
      expect(serialized).not.toContain(clear)
    }
    for (const entry of audits) {
      expect(entry.subjectHash).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(audits[0]?.beforeHash).toBeNull()
    expect(audits[4]?.afterHash).toBeNull()
    expect(audits[1]?.beforeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(audits[1]?.beforeHash).not.toBe(audits[1]?.afterHash)
  })

  test("profile edits and rejected or no-op writes add no entry", async () => {
    await store.updateProfile(OWNER)
    const e = await store.createEntity({
      kind: "personal",
      name: "N",
      tag: "n",
    })
    audits.length = 0
    await store.updateProfile({ signature: "again" })
    await store.updateEntity(e.id, { name: "N" })
    expect(
      await codeOf(() =>
        store.createEntity({ kind: "personal", name: "N", tag: "q" })
      )
    ).toBe("duplicate_name")
    expect(audits).toHaveLength(0)
  })

  test.each([
    [
      "the gate refused the entry",
      new GateRequestError(400, "invalid_payload", "refused"),
    ],
    ["the gate is unreachable", new GateUnavailableError("unreachable")],
  ])("every audited change rolls back when %s", async (_name, failure) => {
    let fail = false
    const gated = createProfileStore(db, {
      audit: () => (fail ? Promise.reject(failure) : Promise.resolve()),
    })
    const kept = await gated.createEntity({
      kind: "company",
      name: "Kept",
      tag: "K",
    })
    await gated.assignAccount({
      connector: "mail",
      accountRef: "box-1",
      entityId: kept.id,
    })
    const entities = await gated.listEntities()
    const assignments = await gated.listAssignments()
    const rows = history()
    fail = true
    const writes: Array<() => Promise<unknown>> = [
      () => gated.createEntity({ kind: "personal", name: "New", tag: "N" }),
      () => gated.updateEntity(kept.id, { name: "Renamed" }),
      () =>
        gated.assignAccount({
          connector: "mail",
          accountRef: "box-2",
          entityId: kept.id,
        }),
      () => gated.unassignAccount("mail", "box-1"),
    ]
    for (const write of writes) {
      await expect(write()).rejects.toBe(failure)
    }
    expect(await gated.listEntities()).toEqual(entities)
    expect(await gated.listAssignments()).toEqual(assignments)
    fail = false
    await gated.unassignAccount("mail", "box-1")
    const free = history()
    fail = true
    await expect(gated.deleteEntity(kept.id)).rejects.toBe(failure)
    expect(await gated.listEntities()).toEqual(entities)
    expect(history()).toBe(free)
    expect(free).toBe(rows + 1)
  })

  test("an audit call the gate never answers times out and rolls the change back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eido-profile-gate-"))
    const socketPath = join(dir, "gate.sock")
    // Accepts the connection and never answers, like a hung gate.
    const held: Socket[] = []
    const silent = createServer((socket) => held.push(socket))
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve))
    try {
      const gated = createProfileStore(db, {
        audit: createAuditClient({ socketPath, timeoutMs: 100 }).record,
      })
      await expect(
        gated.createEntity({ kind: "personal", name: "N", tag: "n" })
      ).rejects.toBeInstanceOf(GateUnavailableError)
      expect(await gated.listEntities()).toEqual([])
      expect(history()).toBe(0)
    } finally {
      for (const socket of held) socket.destroy()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("calls wait for a write whose audit is in flight and never see its statements", async () => {
    let release: (failure?: Error) => void = () => undefined
    let calls = 0
    const gated = createProfileStore(db, {
      audit: () => {
        calls++
        return calls > 1
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              release = (failure) => (failure ? reject(failure) : resolve())
            })
      },
    })
    const first = gated.createEntity({ kind: "personal", name: "A", tag: "a" })
    const read = gated.listEntities()
    const second = gated.createEntity({ kind: "personal", name: "B", tag: "b" })
    let readDone = false
    void read.then(() => {
      readDone = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect([readDone, calls]).toEqual([false, 1])
    release(new GateUnavailableError("unreachable"))
    await expect(first).rejects.toBeInstanceOf(GateUnavailableError)
    expect(await read).toEqual([])
    expect((await second).name).toBe("B")
    expect((await gated.listEntities()).map((e) => e.name)).toEqual(["B"])
  })

  test("a burst behind a hanging gate is capped and refused calls can retry", async () => {
    let release: () => void = () => undefined
    let auditCalls = 0
    const gated = createProfileStore(db, {
      audit: () => {
        auditCalls++
        return auditCalls === 1
          ? new Promise<void>((resolve) => {
              release = resolve
            })
          : Promise.resolve()
      },
    })
    const admitted = Array.from({ length: 32 }, (_, i) =>
      gated.createEntity({ kind: "personal", name: `N${i}`, tag: `n${i}` })
    )
    await Promise.resolve()
    expect(auditCalls).toBe(1)
    expect(
      await codeOf(() =>
        gated.createEntity({ kind: "personal", name: "Overflow", tag: "o" })
      )
    ).toBe("busy")
    expect(await codeOf(() => gated.listEntities())).toBe("busy")
    release()
    await Promise.all(admitted)
    expect(auditCalls).toBe(32)
    expect(
      (await gated.listEntities()).map((entity) => entity.name)
    ).not.toContain("Overflow")
    expect(
      (await gated.createEntity({ kind: "personal", name: "Retry", tag: "r" }))
        .name
    ).toBe("Retry")
  })

  test("the hash of a stored assignment does not depend on the client's key order", async () => {
    const a = await store.createEntity({ kind: "company", name: "A", tag: "a" })
    const b = await store.createEntity({ kind: "company", name: "B", tag: "b" })
    audits.length = 0
    const returned = await store.assignAccount({
      entityId: a.id,
      accountRef: "box-1",
      connector: "mail",
    })
    expect(Object.keys(returned)).toEqual([
      "connector",
      "accountRef",
      "entityId",
    ])
    await store.assignAccount({
      accountRef: "box-1",
      entityId: b.id,
      connector: "mail",
    })
    expect(audits[1]?.beforeHash).toBe(audits[0]?.afterHash)
  })

  test("a transaction that already ended keeps the audit call's error", async () => {
    const failure = new GateUnavailableError("unreachable")
    const gated = createProfileStore(db, {
      audit: () => {
        // Ends the transaction under the store, as a failed COMMIT would.
        db.exec("ROLLBACK")
        return Promise.reject(failure)
      },
    })
    await expect(
      gated.createEntity({ kind: "personal", name: "N", tag: "n" })
    ).rejects.toBe(failure)
    expect(await gated.listEntities()).toEqual([])
  })

  test("drain waits for a write whose audit is in flight, and for calls queued meanwhile", async () => {
    let release: () => void = () => undefined
    let calls = 0
    const gated = createProfileStore(db, {
      audit: () => {
        calls++
        return calls > 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              release = resolve
            })
      },
    })
    const first = gated.createEntity({ kind: "personal", name: "A", tag: "a" })
    let drained = false
    const draining = gated.drain().then(() => {
      drained = true
    })
    const second = gated.createEntity({ kind: "personal", name: "B", tag: "b" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(drained).toBe(false)
    release()
    await draining
    expect(calls).toBe(2)
    db.close()
    expect((await first).name).toBe("A")
    expect((await second).name).toBe("B")
  })
})

describe("profile_history", () => {
  test("every write adds rows and UPDATE or DELETE fail", async () => {
    await store.updateProfile(OWNER)
    const e = await store.createEntity({
      kind: "personal",
      name: "N",
      tag: "n",
    })
    await store.assignAccount({
      connector: "c",
      accountRef: "r",
      entityId: e.id,
    })
    const fields = db
      .prepare("SELECT field FROM profile_history ORDER BY id")
      .all()
      .map((r) => String(r["field"]))
    expect(fields).toEqual([
      "profile.displayName",
      "profile.timezone",
      "profile.workingHours",
      "profile.signature",
      "profile.addresses",
      "entity.create",
      "assignment",
    ])
    expect(() => db.exec("UPDATE profile_history SET field = 'x'")).toThrow(
      /append-only/
    )
    expect(() => db.exec("DELETE FROM profile_history")).toThrow(/append-only/)
  })

  test("a failed write leaves no history row", async () => {
    await store.createEntity({ kind: "personal", name: "N", tag: "n" })
    const rows = history()
    expect(
      await codeOf(() =>
        store.createEntity({ kind: "personal", name: "N", tag: "m" })
      )
    ).toBe("duplicate_name")
    expect(history()).toBe(rows)
  })
})

describe("secrets", () => {
  test("no column stores a password, token or access URL", () => {
    const columns = tables(db)
      .filter((t) =>
        [
          "profile",
          "profile_addresses",
          "entities",
          "entity_assignments",
          "profile_history",
        ].includes(t)
      )
      .flatMap((t) =>
        db
          .prepare(`PRAGMA table_info(${t})`)
          .all()
          .map((r) => String(r["name"]))
      )
    expect(
      columns.filter((c) => /pass|token|secret|url|credential/i.test(c))
    ).toEqual([])
  })
})
