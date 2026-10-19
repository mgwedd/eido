import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { MIGRATIONS, SCHEMA_VERSION, openIndex } from "../index/schema"
import { ProfileError, createProfileStore } from "./index"
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
    audit: (entry) => audits.push(entry),
    now: () => new Date(Date.UTC(2030, 0, 1, 0, 0, tick++)),
  })
})

function codeOf(fn: () => unknown): string {
  try {
    fn()
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
  test("first write needs displayName and timezone, then stores and normalizes", () => {
    expect(store.getProfile()).toBeNull()
    expect(codeOf(() => store.updateProfile({ signature: "x" }))).toBe(
      "invalid"
    )
    const profile = store.updateProfile(OWNER)
    expect(profile.addresses).toEqual([
      { address: "owner@example.test", label: "main" },
    ])
    expect(store.getProfile()).toEqual(profile)
    expect(profile.updatedAt).toMatch(/^2030-01-01T00:00:\d\d\.000Z$/)
  })

  test("partial update keeps other fields and logs only changed fields", () => {
    store.updateProfile(OWNER)
    const before = history()
    store.updateProfile({ signature: "Regards" })
    expect(store.getProfile()?.timezone).toBe("Europe/Zurich")
    expect(history()).toBe(before + 1)
    store.updateProfile({ signature: "Regards" })
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
  ])("rejects %s and leaves the data unchanged", (_name, patch) => {
    store.updateProfile(OWNER)
    const before = store.getProfile()
    const rows = history()
    expect(codeOf(() => store.updateProfile(patch))).toBe("invalid")
    expect(store.getProfile()).toEqual(before)
    expect(history()).toBe(rows)
  })

  test("carries issues in details", () => {
    try {
      store.updateProfile({ displayName: "", timezone: "x/y" })
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
  test("create, list, update, delete round trip with history and audit", () => {
    const company = store.createEntity({
      kind: "company",
      name: "Test Company",
      tag: "TC",
    })
    expect(company.id).toMatch(/^[0-9a-f-]{36}$/)
    store.createEntity({ kind: "property", name: "Test Property", tag: "TP" })
    expect(store.listEntities().map((e) => e.name)).toEqual([
      "Test Company",
      "Test Property",
    ])
    expect(store.entityByTag("tc")?.id).toBe(company.id)
    expect(store.entityByTag("nope")).toBeNull()
    const renamed = store.updateEntity(company.id, { name: "Test Co" })
    expect(renamed).toMatchObject({
      name: "Test Co",
      tag: "TC",
      kind: "company",
    })
    expect(store.updateEntity(company.id, { name: "Test Co" })).toEqual(renamed)
    store.deleteEntity(company.id)
    expect(store.entityByTag("TC")).toBeNull()
    expect(history()).toBe(4)
    expect(audits.map((a) => a.action)).toEqual([
      "entity.create",
      "entity.create",
      "entity.update",
      "entity.delete",
    ])
  })

  test("rejects duplicate name and duplicate tag, case-insensitively, on create and update", () => {
    const a = store.createEntity({ kind: "personal", name: "Alpha", tag: "A" })
    store.createEntity({ kind: "personal", name: "Beta", tag: "B" })
    expect(
      codeOf(() =>
        store.createEntity({ kind: "company", name: "alpha", tag: "Z" })
      )
    ).toBe("duplicate_name")
    expect(
      codeOf(() =>
        store.createEntity({ kind: "company", name: "Zed", tag: "b" })
      )
    ).toBe("duplicate_tag")
    expect(codeOf(() => store.updateEntity(a.id, { name: "BETA" }))).toBe(
      "duplicate_name"
    )
    expect(codeOf(() => store.updateEntity(a.id, { tag: "B" }))).toBe(
      "duplicate_tag"
    )
    expect(store.listEntities()).toHaveLength(2)
  })

  test.each([
    ["open bracket", "a[b"],
    ["close bracket", "a]b"],
    ["line feed", "a\nb"],
    ["carriage return", "a\rb"],
    ["too long", "x".repeat(25)],
    ["blank", "   "],
    ["empty", ""],
  ])("rejects a tag with %s", (_name, tag) => {
    expect(
      codeOf(() => store.createEntity({ kind: "personal", name: "N", tag }))
    ).toBe("invalid")
    const e = store.createEntity({ kind: "personal", name: "Ok", tag: "ok" })
    expect(codeOf(() => store.updateEntity(e.id, { tag }))).toBe("invalid")
    expect(store.entityByTag("ok")?.id).toBe(e.id)
  })

  test("accepts a tag of exactly 24 characters; rejects bad names and unknown kinds", () => {
    store.createEntity({ kind: "personal", name: "Long", tag: "x".repeat(24) })
    expect(
      codeOf(() =>
        store.createEntity({ kind: "personal", name: " \t ", tag: "t" })
      )
    ).toBe("invalid")
    expect(
      codeOf(() => store.createEntity({ kind: "cat", name: "C", tag: "c" }))
    ).toBe("invalid")
  })

  test("updateEntity and deleteEntity report a missing entity", () => {
    expect(codeOf(() => store.updateEntity("missing", { name: "x" }))).toBe(
      "not_found"
    )
    expect(codeOf(() => store.deleteEntity("missing"))).toBe("not_found")
  })

  test("a name with a quote and SQL round-trips as data", () => {
    const name = `Bob's "Co"'; DROP TABLE entities; --`
    const created = store.createEntity({ kind: "company", name, tag: "bob" })
    expect(store.listEntities()[0]?.name).toBe(name)
    expect(store.entityByTag("bob")?.id).toBe(created.id)
    expect(tables(db)).toContain("entities")
  })
})

describe("deleteEntity references", () => {
  test("blocked by an assignment, then by a document, then succeeds", () => {
    const e = store.createEntity({
      kind: "company",
      name: "Test Company",
      tag: "TC",
    })
    store.assignAccount({
      connector: "mail",
      accountRef: "box-1",
      entityId: e.id,
    })
    let blocked: unknown
    try {
      store.deleteEntity(e.id)
    } catch (error) {
      blocked = error
    }
    expect(blocked).toMatchObject({
      code: "entity_in_use",
      details: ["entity_assignments"],
    })
    store.unassignAccount("mail", "box-1")

    db.prepare(
      "INSERT INTO documents (sha256, source, source_ref, mime, entity_id, ingested_at) VALUES ('h','s','r','text/plain',?, 't')"
    ).run(e.id)
    expect(codeOf(() => store.deleteEntity(e.id))).toBe("entity_in_use")
    expect(store.listEntities()).toHaveLength(1)

    const free = store.createEntity({
      kind: "personal",
      name: "Free",
      tag: "F",
    })
    store.deleteEntity(free.id)
    expect(store.listEntities()).toHaveLength(1)
  })
})

describe("assignments", () => {
  test("assignAccount moves an account rather than adding a second assignment", () => {
    const a = store.createEntity({ kind: "company", name: "A", tag: "a" })
    const b = store.createEntity({ kind: "property", name: "B", tag: "b" })
    expect(store.entityForAccount("cal", "work")).toBeNull()
    store.assignAccount({
      connector: "cal",
      accountRef: "work",
      entityId: a.id,
    })
    expect(store.entityForAccount("cal", "work")?.id).toBe(a.id)
    store.assignAccount({
      connector: "cal",
      accountRef: "work",
      entityId: b.id,
    })
    expect(store.entityForAccount("cal", "work")?.id).toBe(b.id)
    expect(count("SELECT count(*) AS n FROM entity_assignments")).toBe(1)
    const rows = history()
    store.assignAccount({
      connector: "cal",
      accountRef: "work",
      entityId: b.id,
    })
    expect(history()).toBe(rows)
  })

  test("rejects an unknown entity and a malformed assignment; unassign reports what happened", () => {
    expect(
      codeOf(() =>
        store.assignAccount({
          connector: "cal",
          accountRef: "w",
          entityId: "0".repeat(36),
        })
      )
    ).toBe("not_found")
    expect(codeOf(() => store.assignAccount({ connector: "cal" }))).toBe(
      "invalid"
    )
    expect(store.unassignAccount("cal", "w")).toBe(false)
  })
})

describe("audit", () => {
  test("each entity and assignment change appends one entry with hashes only", () => {
    const e = store.createEntity({
      kind: "company",
      name: "Secret Name",
      tag: "SECRETTAG",
    })
    store.updateEntity(e.id, { tag: "OTHERTAG" })
    store.assignAccount({
      connector: "mail",
      accountRef: "owner@example.test",
      entityId: e.id,
    })
    store.unassignAccount("mail", "owner@example.test")
    store.deleteEntity(e.id)
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

  test("profile edits and rejected or no-op writes add no entry", () => {
    store.updateProfile(OWNER)
    const e = store.createEntity({ kind: "personal", name: "N", tag: "n" })
    audits.length = 0
    store.updateProfile({ signature: "again" })
    store.updateEntity(e.id, { name: "N" })
    expect(
      codeOf(() =>
        store.createEntity({ kind: "personal", name: "N", tag: "q" })
      )
    ).toBe("duplicate_name")
    expect(audits).toHaveLength(0)
  })

  test("a sink that throws rolls the change back", () => {
    const failing = createProfileStore(db, {
      audit: () => {
        throw new Error("gate unreachable")
      },
    })
    expect(() =>
      failing.createEntity({ kind: "personal", name: "N", tag: "n" })
    ).toThrow("gate unreachable")
    expect(store.listEntities()).toHaveLength(0)
    expect(history()).toBe(0)
  })
})

describe("profile_history", () => {
  test("every write adds rows and UPDATE or DELETE fail", () => {
    store.updateProfile(OWNER)
    const e = store.createEntity({ kind: "personal", name: "N", tag: "n" })
    store.assignAccount({ connector: "c", accountRef: "r", entityId: e.id })
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

  test("a failed write leaves no history row", () => {
    store.createEntity({ kind: "personal", name: "N", tag: "n" })
    const rows = history()
    expect(
      codeOf(() =>
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
