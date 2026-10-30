import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, test } from "vitest"
import { ingestBatch } from "../index/ingest"
import { MIGRATIONS, openIndex } from "../index/schema"
import { createProfileStore } from "../profile/store"
import { LedgerError, openDataDb } from "./index"
import { addDocs, ledgerFixture, sha, testDoc } from "./ledger.test-support"
import { LEDGER_MIGRATIONS } from "./migration"

const tempPath = (): string =>
  join(mkdtempSync(join(tmpdir(), "eido-ledger-")), "data.db")

/** Every table, index and trigger with its SQL: equal dumps mean equal schemas. */
const schemaOf = (db: DatabaseSync): string[] =>
  db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all()
    .map(
      (r) => `${String(r["type"])} ${String(r["name"])}: ${String(r["sql"])}`
    )

const ledgerVersion = (db: DatabaseSync): number =>
  Number(
    db.prepare("SELECT version FROM ledger_schema WHERE id = 1").get()?.[
      "version"
    ]
  )

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof LedgerError) return error.code
    throw error
  }
  return "none"
}

/** A file at the #19 schema (index v1 only) holding two documents that have no entity. */
function databaseAtIssue19Schema(path: string): string[] {
  const old = new DatabaseSync(path)
  old.exec(MIGRATIONS[0] ?? "")
  old.exec("PRAGMA user_version = 1")
  const insert = old.prepare(
    `INSERT INTO documents (sha256, source, source_ref, mime, entity_id, ingested_at, blob_path)
     VALUES (?, 'gmail', ?, 'message/rfc822', NULL, '2030-01-01T00:00:00.000Z', ?)`
  )
  insert.run(sha("old-1"), "ref-old-1", "blobs/old-1")
  insert.run(sha("old-2"), "ref-old-2", null)
  old.close()
  return [sha("old-1"), sha("old-2")]
}

/** Upgrade to the index schema and create the entity that will be the default, through #80. */
async function createDefaultEntity(path: string): Promise<string> {
  const db = openIndex(path)
  const profile = createProfileStore(db, { audit: () => Promise.resolve() })
  const entity = await profile.createEntity({
    kind: "personal",
    name: "Test Personal",
    tag: "ME",
  })
  db.close()
  return entity.id
}

describe("migrations", () => {
  test("an empty database and one at the #19 schema end at the same schema; reopening changes nothing", async () => {
    const fresh = openDataDb(tempPath())
    const path = tempPath()
    databaseAtIssue19Schema(path)
    const defaultEntityId = await createDefaultEntity(path)
    const upgraded = openDataDb(path, { defaultEntityId })
    expect(schemaOf(upgraded)).toEqual(schemaOf(fresh))
    expect(ledgerVersion(upgraded)).toBe(3)
    const documentsBefore = upgraded
      .prepare("SELECT * FROM documents ORDER BY sha256")
      .all()
    upgraded.close()

    const again = openDataDb(path)
    expect(schemaOf(again)).toEqual(schemaOf(fresh))
    expect(ledgerVersion(again)).toBe(3)
    expect(
      again.prepare("SELECT * FROM documents ORDER BY sha256").all()
    ).toEqual(documentsBefore)
    again.close()
    fresh.close()
  })

  test("migrating a database that holds documents backfills them with the default entity, then documents are frozen", async () => {
    const path = tempPath()
    const [first, second] = databaseAtIssue19Schema(path)
    const defaultEntityId = await createDefaultEntity(path)
    const db = openDataDb(path, { defaultEntityId })
    expect(
      db
        .prepare("SELECT sha256, entity_id FROM documents ORDER BY sha256")
        .all()
        .map((r) => [r["sha256"], r["entity_id"]])
    ).toEqual([first, second].sort().map((s) => [s, defaultEntityId]))
    expect(() =>
      db.prepare("UPDATE documents SET entity_id = entity_id").run()
    ).toThrow(/documents are immutable/)
    expect(() =>
      db.prepare("UPDATE documents SET mime = 'text/plain'").run()
    ).toThrow(/documents are immutable/)
    expect(() => db.prepare("DELETE FROM documents").run()).toThrow(
      /documents are immutable/
    )
    db.close()
  })

  test("documents without an entity and no default entity: the migration fails and rolls back", () => {
    const path = tempPath()
    databaseAtIssue19Schema(path)
    expect(codeOf(() => openDataDb(path))).toBe("default_entity_required")
    const db = openIndex(path)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r["name"])
    expect(tables).not.toContain("obligations")
    expect(tables).not.toContain("ledger_schema")
    db.close()
  })

  test("a default entity that does not exist is refused", () => {
    const path = tempPath()
    databaseAtIssue19Schema(path)
    expect(
      codeOf(() => openDataDb(path, { defaultEntityId: "no-such-entity" }))
    ).toBe("entity_not_found")
  })

  test("a database from a newer ledger version is refused", () => {
    const path = tempPath()
    const db = openDataDb(path)
    db.exec("UPDATE ledger_schema SET version = 4")
    db.close()
    expect(codeOf(() => openDataDb(path))).toBe("newer_schema")
  })

  test("a database at ledger v1 migrates: stored rows stay, provenance defaults clean, new checks apply", async () => {
    const path = tempPath()
    const old = openIndex(path)
    const profile = createProfileStore(old, { audit: () => Promise.resolve() })
    const a = await profile.createEntity({
      kind: "property",
      name: "A",
      tag: "A",
    })
    const b = await profile.createEntity({
      kind: "company",
      name: "B",
      tag: "B",
    })
    const [doc = ""] = addDocs(old, [testDoc("v1", { entityId: a.id })])
    old.exec(LEDGER_MIGRATIONS[0] ?? "")
    old.exec("INSERT INTO ledger_schema (id, version) VALUES (1, 1)")
    // Both pass the v1 schema: an impossible date, and an entity unlike the document's.
    const insert = old.prepare(
      `INSERT INTO obligations (entity_id, action, due_at, status, doc_id, source_span)
       VALUES (?, 'Pay', ?, 'open', ?, '{"start":0,"end":3}')`
    )
    insert.run(a.id, "2030-02-30", doc)
    insert.run(b.id, "2030-02-28", doc)
    old.close()

    const db = openDataDb(path)
    expect(ledgerVersion(db)).toBe(3)
    expect(
      db
        .prepare(
          "SELECT injection_suspected, injection_reasons FROM obligations ORDER BY id"
        )
        .all()
    ).toEqual([
      { injection_suspected: 0, injection_reasons: "[]" },
      { injection_suspected: 0, injection_reasons: "[]" },
    ])
    expect(
      db
        .prepare("SELECT entity_id, due_at FROM obligations ORDER BY id")
        .all()
        .map((r) => [r["entity_id"], r["due_at"]])
    ).toEqual([
      [a.id, "2030-02-30"],
      [b.id, "2030-02-28"],
    ])
    // A stored row can still change status, and gets no new check on columns it leaves alone.
    db.prepare("UPDATE obligations SET status = 'done' WHERE id = 1").run()
    expect(() =>
      db
        .prepare("UPDATE obligations SET due_at = '2030-13-45' WHERE id = 1")
        .run()
    ).toThrow(/real date/)
    expect(() =>
      db.prepare("UPDATE obligations SET entity_id = ? WHERE id = 1").run(b.id)
    ).toThrow(/document entity/)
    db.close()
  })

  test("the backfill trigger allows only entity_id NULL -> known entity", async () => {
    const path = tempPath()
    databaseAtIssue19Schema(path)
    const entityId = await createDefaultEntity(path)
    // The ledger schema without its backfill, so documents with no entity are still there.
    const db = openIndex(path)
    db.exec(LEDGER_MIGRATIONS[0] ?? "")
    const doc = sha("old-1")
    expect(() =>
      db
        .prepare(
          "UPDATE documents SET entity_id = ?, mime = 'text/plain' WHERE sha256 = ?"
        )
        .run(entityId, doc)
    ).toThrow(/documents are immutable/)
    expect(() =>
      db
        .prepare("UPDATE documents SET entity_id = ? WHERE sha256 = ?")
        .run("no-such-entity", doc)
    ).toThrow(/known entity/)
    db.prepare("UPDATE documents SET entity_id = ? WHERE sha256 = ?").run(
      entityId,
      doc
    )
    expect(() =>
      db
        .prepare("UPDATE documents SET entity_id = NULL WHERE sha256 = ?")
        .run(doc)
    ).toThrow(/documents are immutable/)
    db.close()
  })
})

describe("every document has exactly one entity", () => {
  test("inserting a document without an entity, or with an unknown one, fails", async () => {
    const { db, property } = await ledgerFixture()
    const ingest = (entityId?: string) =>
      ingestBatch(db, {
        connector: "gmail",
        stream: "inbox",
        documents: [testDoc("m1", entityId === undefined ? {} : { entityId })],
        nextCursor: "c1",
      })
    expect(() => ingest()).toThrow(/known entity/)
    expect(() => ingest("no-such-entity")).toThrow(/known entity/)
    expect(db.prepare("SELECT count(*) AS n FROM documents").get()?.["n"]).toBe(
      0
    )
    expect(ingest(property.id).inserted).toBe(1)
    // A repeat of the stored document is skipped, with or without an entity.
    expect(ingest()).toEqual({
      inserted: 0,
      skipped: 1,
      uidvalidityChanged: false,
    })
    expect(
      db.prepare("SELECT entity_id FROM documents").get()?.["entity_id"]
    ).toBe(property.id)
  })

  test("a stored document cannot be updated or deleted", async () => {
    const { db, property, company } = await ledgerFixture()
    const [doc] = addDocs(db, [testDoc("m1", { entityId: property.id })])
    expect(() =>
      db
        .prepare("UPDATE documents SET entity_id = ? WHERE sha256 = ?")
        .run(company.id, doc ?? "")
    ).toThrow(/documents are immutable/)
    expect(() =>
      db.prepare("DELETE FROM documents WHERE sha256 = ?").run(doc ?? "")
    ).toThrow(/documents are immutable/)
  })
})
