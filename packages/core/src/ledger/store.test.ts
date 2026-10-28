import type { DatabaseSync } from "node:sqlite"
import type { ExtractedFields } from "@eido/schemas"
import { beforeEach, describe, expect, test } from "vitest"
import { search } from "../index/search"
import { ProfileError } from "../profile/errors"
import type { ProfileStore } from "../profile/store"
import type { Entity } from "../profile/types"
import {
  LedgerError,
  confirmExtraction,
  getObligationSource,
  insertExtraction,
  insertObligation,
  listObligations,
} from "./index"
import type { ObligationInput } from "./index"
import { addDocs, ledgerFixture, testDoc } from "./ledger.test-support"

let db: DatabaseSync
let profile: ProfileStore
let property: Entity
let company: Entity
let docA: string
let docB: string

beforeEach(async () => {
  ;({ db, profile, property, company } = await ledgerFixture())
  ;[docA = "", docB = ""] = addDocs(db, [
    testDoc("a", { entityId: property.id, blobPath: "blobs/a.eml" }),
    testDoc("b", { entityId: company.id }),
  ])
})

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof LedgerError) return error.code
    throw error
  }
  return "none"
}

const FIELDS: ExtractedFields = {
  action: { raw: "Pay the invoice", span: { start: 10, end: 25 } },
  amount: {
    raw: "CHF 120.00",
    span: { start: 30, end: 40 },
    status: "parsed",
    value: { amount_minor: 12000, currency: "CHF" },
  },
}

const obligation = (over: Partial<ObligationInput> = {}): ObligationInput => ({
  entityId: property.id,
  party: "Example Utility",
  action: "Pay the invoice",
  dueAt: "2030-02-01",
  status: "open",
  docId: docA,
  span: { start: 10, end: 25 },
  ...over,
})

const rawObligation = (docId: string | null, span: string | null) =>
  db
    .prepare(
      `INSERT INTO obligations (entity_id, action, status, doc_id, source_span)
       VALUES (?, 'Pay', 'open', ?, ?)`
    )
    .run(property.id, docId, span)

const rawExtraction = () =>
  insertExtraction(db, {
    docId: docA,
    schema: "extracted-fields",
    status: "extracted",
    fields: FIELDS,
    confidence: { action: 0.9, amount: 0.4 },
    model: "local-test-model",
    createdAt: "2030-01-01T00:00:00.000Z",
  })

describe("no ledger row without a source link", () => {
  test("the database rejects an obligation with a NULL or unknown doc_id", () => {
    const span = JSON.stringify({ start: 0, end: 5 })
    expect(() => rawObligation(null, span)).toThrow(/NOT NULL/)
    expect(() => rawObligation("f".repeat(64), span)).toThrow(/FOREIGN KEY/)
  })

  test.each([
    ["NULL", null, /NOT NULL/],
    ["end equal to start", '{"start":5,"end":5}', /CHECK/],
    ["end before start", '{"start":5,"end":2}', /CHECK/],
    ["negative start", '{"start":-1,"end":2}', /CHECK/],
    ["no start", '{"end":2}', /CHECK/],
    ["non-integer end", '{"start":0,"end":"7"}', /CHECK/],
    ["invalid JSON", "{start:0,end:5", /CHECK/],
  ])("the database rejects a source span that is %s", (_, span, error) => {
    expect(() => rawObligation(docA, span)).toThrow(error)
  })

  test("the database rejects an extraction without doc_id", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO extractions (schema, status, fields_json, model, created_at)
           VALUES ('extracted-fields', 'processed_empty', '{}', 'none', '2030-01-01')`
        )
        .run()
    ).toThrow(/NOT NULL/)
  })

  test("insertObligation fails with a typed error for a missing document, span or entity", () => {
    expect(
      codeOf(() => insertObligation(db, obligation({ docId: "f".repeat(64) })))
    ).toBe("document_not_found")
    expect(
      codeOf(() =>
        insertObligation(db, obligation({ span: { start: 4, end: 4 } }))
      )
    ).toBe("invalid_span")
    expect(
      codeOf(() =>
        insertObligation(db, obligation({ entityId: "no-such-entity" }))
      )
    ).toBe("entity_not_found")
    expect(listObligations(db)).toEqual([])
  })

  test("insertExtraction fails with a typed error for a missing document", () => {
    expect(
      codeOf(() =>
        insertExtraction(db, {
          docId: "f".repeat(64),
          schema: "extracted-fields",
          status: "processed_empty",
          model: "none",
          createdAt: "2030-01-01T00:00:00.000Z",
        })
      )
    ).toBe("document_not_found")
  })
})

describe("per-field confidence", () => {
  const confidences = (id: number) =>
    db
      .prepare(
        "SELECT field, confidence FROM extraction_field_confidence WHERE extraction_id = ? ORDER BY field"
      )
      .all(id)
      .map((r) => [r["field"], r["confidence"]])

  const rawConfidence = (id: number, field: string, confidence: number) =>
    db
      .prepare(
        "INSERT INTO extraction_field_confidence (extraction_id, field, confidence) VALUES (?, ?, ?)"
      )
      .run(id, field, confidence)

  test("two fields of one extraction store different confidences", () => {
    const id = rawExtraction()
    expect(confidences(id)).toEqual([
      ["action", 0.9],
      ["amount", 0.4],
    ])
    expect(
      JSON.parse(
        String(
          db
            .prepare("SELECT fields_json FROM extractions WHERE id = ?")
            .get(id)?.["fields_json"]
        )
      )
    ).toEqual(FIELDS)
  })

  test("the database rejects a confidence outside 0..1, an unknown field, a repeat or a field the extraction lacks", () => {
    // Written directly, so the party field has no confidence row yet.
    const id = Number(
      db
        .prepare(
          `INSERT INTO extractions (doc_id, schema, status, fields_json, model, created_at)
           VALUES (?, 'extracted-fields', 'extracted', ?, 'local-test-model', '2030-01-01')`
        )
        .run(
          docA,
          JSON.stringify({
            ...FIELDS,
            party: { raw: "Example Utility", span: { start: 0, end: 15 } },
          })
        ).lastInsertRowid
    )
    rawConfidence(id, "action", 0.9)
    rawConfidence(id, "amount", 0.4)
    expect(() => rawConfidence(id, "party", 1.5)).toThrow(/CHECK/)
    expect(() => rawConfidence(id, "party", -0.1)).toThrow(/CHECK/)
    // An unknown field is never a key of fields_json, so the presence trigger refuses it first.
    expect(() => rawConfidence(id, "vendor", 0.5)).toThrow(/does not hold/)
    expect(() => rawConfidence(id, "action", 0.5)).toThrow(/UNIQUE|PRIMARY/)
    expect(() => rawConfidence(id, "reference_number", 0.5)).toThrow(
      /does not hold/
    )
    rawConfidence(id, "party", 1)
    expect(confidences(id)).toEqual([
      ["action", 0.9],
      ["amount", 0.4],
      ["party", 1],
    ])
  })

  test("a processed_empty extraction has '{}', no confidence rows and accepts none", () => {
    const id = insertExtraction(db, {
      docId: docA,
      schema: "extracted-fields",
      status: "processed_empty",
      model: "none",
      createdAt: "2030-01-01T00:00:00.000Z",
    })
    expect(
      db
        .prepare(
          "SELECT status, fields_json, model FROM extractions WHERE id = ?"
        )
        .get(id)
    ).toEqual({ status: "processed_empty", fields_json: "{}", model: "none" })
    expect(confidences(id)).toEqual([])
    expect(() => rawConfidence(id, "action", 0.5)).toThrow(/does not hold/)
    expect(() =>
      db
        .prepare(
          `INSERT INTO extractions (doc_id, schema, status, fields_json, model, created_at)
           VALUES (?, 'extracted-fields', 'processed_empty', '{"action":{}}', 'none', '2030-01-01')`
        )
        .run(docA)
    ).toThrow(/CHECK/)
  })

  test("insertExtraction refuses a present field without confidence, or a confidence without its field", () => {
    const base = {
      docId: docA,
      schema: "extracted-fields",
      status: "extracted" as const,
      fields: FIELDS,
      model: "local-test-model",
      createdAt: "2030-01-01T00:00:00.000Z",
    }
    expect(
      codeOf(() =>
        insertExtraction(db, { ...base, confidence: { action: 0.9 } })
      )
    ).toBe("invalid_confidence")
    expect(
      codeOf(() =>
        insertExtraction(db, {
          ...base,
          confidence: { action: 0.9, amount: 0.4, party: 0.5 },
        })
      )
    ).toBe("invalid_confidence")
    expect(
      db.prepare("SELECT count(*) AS n FROM extractions").get()?.["n"]
    ).toBe(0)
  })

  test("a confidence outside 0..1 is refused before anything is written", () => {
    expect(
      codeOf(() =>
        insertExtraction(db, {
          docId: docA,
          schema: "extracted-fields",
          status: "extracted",
          fields: FIELDS,
          confidence: { action: 0.9, amount: 2 },
          model: "local-test-model",
          createdAt: "2030-01-01T00:00:00.000Z",
        })
      )
    ).toBe("invalid_confidence")
    expect(
      db.prepare("SELECT count(*) AS n FROM extractions").get()?.["n"]
    ).toBe(0)
  })

  test("stored extractions and confidences cannot be changed or deleted", () => {
    const id = rawExtraction()
    expect(() =>
      db.exec("UPDATE extraction_field_confidence SET confidence = 0.1")
    ).toThrow(/append-only/)
    expect(() => db.exec("DELETE FROM extraction_field_confidence")).toThrow(
      /append-only/
    )
    expect(() =>
      db.prepare("DELETE FROM extractions WHERE id = ?").run(id)
    ).toThrow(/append-only/)
  })
})

describe("obligation status", () => {
  test.each(["open", "done", "dismissed"])("accepts %s", (status) => {
    db.prepare(
      `INSERT INTO obligations (entity_id, action, status, doc_id, source_span)
       VALUES (?, 'Pay', ?, ?, '{"start":0,"end":3}')`
    ).run(property.id, status, docA)
    expect(listObligations(db).map((o) => o.status)).toEqual([status])
  })

  test.each(["waiting", "owed", "Open", "draft_ready", ""])(
    "rejects %j",
    (status) => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO obligations (entity_id, action, status, doc_id, source_span)
             VALUES (?, 'Pay', ?, ?, '{"start":0,"end":3}')`
          )
          .run(property.id, status, docA)
      ).toThrow(/CHECK/)
    }
  )

  test("rejects a due date that is not YYYY-MM-DD", () => {
    expect(() =>
      insertObligation(db, obligation({ dueAt: "1 Feb 2030" }))
    ).toThrow(/real date/)
  })

  test.each(["2030-13-45", "2030-02-30", "2030-00-10", "2031-02-29"])(
    "rejects the impossible date %s, on insert and on update",
    (dueAt) => {
      expect(() => insertObligation(db, obligation({ dueAt }))).toThrow(
        /real date/
      )
      const id = insertObligation(db, obligation())
      expect(() =>
        db
          .prepare("UPDATE obligations SET due_at = ? WHERE id = ?")
          .run(dueAt, id)
      ).toThrow(/real date/)
    }
  )

  test.each(["2030-02-28", "2032-02-29"])(
    "accepts the real date %s",
    (dueAt) => {
      insertObligation(db, obligation({ dueAt }))
      expect(listObligations(db).map((o) => o.dueAt)).toEqual([dueAt])
    }
  )
})

describe("an obligation has its document's entity", () => {
  test("insertObligation refuses another entity with entity_mismatch", () => {
    expect(
      codeOf(() => insertObligation(db, obligation({ entityId: company.id })))
    ).toBe("entity_mismatch")
    expect(listObligations(db)).toEqual([])
    expect(
      insertObligation(db, obligation({ docId: docB, entityId: company.id }))
    ).toBe(1)
  })

  test("the database refuses a mismatch written directly, on insert and on update", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO obligations (entity_id, action, status, doc_id, source_span)
           VALUES (?, 'Pay', 'open', ?, '{"start":0,"end":3}')`
        )
        .run(company.id, docA)
    ).toThrow(/document entity/)
    const id = insertObligation(db, obligation())
    expect(() =>
      db
        .prepare("UPDATE obligations SET entity_id = ? WHERE id = ?")
        .run(company.id, id)
    ).toThrow(/document entity/)
  })
})

describe("confirmed_at", () => {
  test("can be set once, then cannot be changed or cleared", () => {
    const id = rawExtraction()
    confirmExtraction(db, id, "2030-01-02T00:00:00.000Z")
    expect(
      db.prepare("SELECT confirmed_at FROM extractions WHERE id = ?").get(id)?.[
        "confirmed_at"
      ]
    ).toBe("2030-01-02T00:00:00.000Z")
    expect(
      codeOf(() => confirmExtraction(db, id, "2030-01-03T00:00:00.000Z"))
    ).toBe("already_confirmed")
    const set = (value: string | null) =>
      db
        .prepare("UPDATE extractions SET confirmed_at = ? WHERE id = ?")
        .run(value, id)
    expect(() => set("2030-01-03T00:00:00.000Z")).toThrow(/set once/)
    expect(() => set(null)).toThrow(/set once/)
    expect(
      db.prepare("SELECT confirmed_at FROM extractions WHERE id = ?").get(id)?.[
        "confirmed_at"
      ]
    ).toBe("2030-01-02T00:00:00.000Z")
  })

  test("cannot be cleared before it is set, and other columns cannot change", () => {
    const id = rawExtraction()
    expect(() =>
      db
        .prepare("UPDATE extractions SET confirmed_at = NULL WHERE id = ?")
        .run(id)
    ).toThrow(/set once/)
    expect(() =>
      db.prepare("UPDATE extractions SET model = 'other' WHERE id = ?").run(id)
    ).toThrow(/immutable/)
  })

  test("confirming an unknown extraction fails", () => {
    expect(
      codeOf(() => confirmExtraction(db, 999, "2030-01-02T00:00:00.000Z"))
    ).toBe("extraction_not_found")
  })
})

describe("listObligations", () => {
  test("returns only the entity's rows, ordered by due date with no due date last", () => {
    const late = insertObligation(db, obligation({ dueAt: "2030-03-01" }))
    const none = insertObligation(
      db,
      obligation({ dueAt: undefined, party: undefined })
    )
    const early = insertObligation(db, obligation({ dueAt: "2030-01-15" }))
    insertObligation(
      db,
      obligation({ entityId: company.id, docId: docB, dueAt: "2030-01-01" })
    )
    const rows = listObligations(db, { entityId: property.id })
    expect(rows.map((o) => o.id)).toEqual([early, late, none])
    expect(rows[2]).toEqual({
      id: none,
      entity: {
        id: property.id,
        kind: "property",
        name: "Test Property",
        tag: "PROP",
      },
      party: null,
      action: "Pay the invoice",
      dueAt: null,
      status: "open",
      docId: docA,
      span: { start: 10, end: 25 },
      injectionSuspected: false,
      injectionReasons: [],
    })
    expect(listObligations(db).map((o) => o.entity.name)).toEqual([
      "Test Company",
      "Test Property",
      "Test Property",
      "Test Property",
    ])
  })

  test("filters by status and by due date (exclusive, no due date left out)", () => {
    const open = insertObligation(db, obligation({ dueAt: "2030-01-10" }))
    insertObligation(db, obligation({ dueAt: "2030-01-05", status: "done" }))
    insertObligation(db, obligation({ dueAt: "2030-02-01" }))
    insertObligation(db, obligation({ dueAt: undefined }))
    expect(
      listObligations(db, { status: "open", dueBefore: "2030-02-01" }).map(
        (o) => o.id
      )
    ).toEqual([open])
  })
})

describe("entities come from the profile store (#80)", () => {
  test("a rename through the profile store shows in listObligations", async () => {
    insertObligation(db, obligation())
    await profile.updateEntity(property.id, {
      name: "Renamed Property",
      tag: "RP",
    })
    expect(
      listObligations(db).map((o) => [o.entity.name, o.entity.tag])
    ).toEqual([["Renamed Property", "RP"]])
  })

  test("an entity referenced by a document or an obligation is not deleted", async () => {
    // The company has a document (docB); the spare entity has a document and an obligation citing it.
    const spare = await profile.createEntity({
      kind: "property",
      name: "Spare Property",
      tag: "SP",
    })
    const [docSpare = ""] = addDocs(db, [
      testDoc("spare", { entityId: spare.id }),
    ])
    insertObligation(db, obligation({ entityId: spare.id, docId: docSpare }))
    const refusal = async (id: string) => {
      try {
        await profile.deleteEntity(id)
      } catch (error) {
        if (error instanceof ProfileError) return [error.code, error.details]
        throw error
      }
      return ["deleted"]
    }
    expect(await refusal(company.id)).toEqual(["entity_in_use", ["documents"]])
    expect(await refusal(spare.id)).toEqual([
      "entity_in_use",
      ["documents", "obligations"],
    ])
    expect(() =>
      db.prepare("DELETE FROM entities WHERE id = ?").run(spare.id)
    ).toThrow(/still referenced/)
    expect((await profile.listEntities()).map((e) => e.name)).toEqual([
      "Spare Property",
      "Test Company",
      "Test Property",
    ])
  })
})

describe("an obligation keeps its source", () => {
  test("its status can change, its document and span cannot, and it is never deleted", () => {
    const id = insertObligation(db, obligation())
    db.prepare("UPDATE obligations SET status = 'done' WHERE id = ?").run(id)
    expect(listObligations(db).map((o) => o.status)).toEqual(["done"])
    expect(() =>
      db.prepare("UPDATE obligations SET doc_id = ? WHERE id = ?").run(docB, id)
    ).toThrow(/keeps its source/)
    expect(() =>
      db
        .prepare("UPDATE obligations SET source_span = ? WHERE id = ?")
        .run('{"start":0,"end":1}', id)
    ).toThrow(/keeps its source/)
    expect(() =>
      db.prepare("DELETE FROM obligations WHERE id = ?").run(id)
    ).toThrow(/not deleted/)
  })

  test("an obligation id is never reused", () => {
    const first = insertObligation(db, obligation())
    db.exec("DROP TRIGGER obligations_no_delete")
    db.prepare("DELETE FROM obligations WHERE id = ?").run(first)
    expect(insertObligation(db, obligation())).toBe(first + 1)
  })

  test("a span stored as a BLOB, or with a mistyped optional field, is refused", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO obligations (entity_id, action, status, doc_id, source_span)
           VALUES (?, 'Pay', 'open', ?, ?)`
        )
        .run(property.id, docA, new TextEncoder().encode('{"start":0,"end":3}'))
    ).toThrow(/CHECK/)
    expect(
      codeOf(() =>
        insertObligation(
          db,
          obligation({
            // A caller holding unchecked JSON; the schema type says message_id is a string.
            span: JSON.parse(
              '{"start":0,"end":3,"message_id":7}'
            ) as ObligationInput["span"],
          })
        )
      )
    ).toBe("invalid_span")
  })
})

describe("getObligationSource", () => {
  test("returns the document's blob path and the stored span", () => {
    const span = {
      start: 3,
      end: 18,
      message_id: "<m1@example.invalid>",
      line: 2,
    }
    const id = insertObligation(db, obligation({ span }))
    expect(getObligationSource(db, id)).toEqual({
      docId: docA,
      blobPath: "blobs/a.eml",
      span,
      injectionSuspected: false,
      injectionReasons: [],
    })
    const noBlob = insertObligation(
      db,
      obligation({ docId: docB, entityId: company.id })
    )
    expect(getObligationSource(db, noBlob)?.blobPath).toBeNull()
    expect(getObligationSource(db, 999)).toBeNull()
  })

  test("a span corrupted outside the ledger is reported, not returned", () => {
    const id = insertObligation(db, obligation())
    // A file edited by hand, outside the ledger's constraints and triggers.
    db.exec("DROP TRIGGER obligations_source_fixed")
    db.exec("PRAGMA ignore_check_constraints = ON")
    db.prepare("UPDATE obligations SET source_span = '[1,2]' WHERE id = ?").run(
      id
    )
    expect(() => getObligationSource(db, id)).toThrow(/malformed/)
  })
})

describe("parameterized statements only", () => {
  test("a hostile document, obligation and extraction round-trip as data", () => {
    const hostile = `O'Brien'); DROP TABLE obligations; -- "quoted" ; DROP TABLE documents;`
    const [doc = ""] = addDocs(db, [
      testDoc("hostile", {
        entityId: property.id,
        title: hostile,
        body: hostile,
      }),
    ])
    const id = insertObligation(
      db,
      obligation({ docId: doc, party: hostile, action: hostile })
    )
    const extraction = insertExtraction(db, {
      docId: doc,
      schema: hostile,
      status: "extracted",
      fields: {
        action: { raw: hostile, span: { start: 0, end: hostile.length } },
      },
      confidence: { action: 0.5 },
      model: hostile,
      createdAt: "2030-01-01T00:00:00.000Z",
    })
    expect(listObligations(db, { entityId: hostile })).toEqual([])
    const stored = listObligations(db).find((o) => o.id === id)
    expect([stored?.party, stored?.action]).toEqual([hostile, hostile])
    expect(
      db
        .prepare(
          "SELECT schema, model, fields_json FROM extractions WHERE id = ?"
        )
        .get(extraction)
    ).toEqual({
      schema: hostile,
      model: hostile,
      fields_json: JSON.stringify({
        action: { raw: hostile, span: { start: 0, end: hostile.length } },
      }),
    })
    expect(search(db, { text: "O'Brien" }).map((h) => h.sha256)).toEqual([doc])
  })
})

describe("injection provenance", () => {
  test("inconsistent flags and reasons fail before writing, including direct SQL", () => {
    expect(
      codeOf(() =>
        insertObligation(db, obligation({ injectionSuspected: true }))
      )
    ).toBe("invalid_injection_provenance")
    expect(
      codeOf(() =>
        insertObligation(db, obligation({ injectionReasons: ["fence-tag"] }))
      )
    ).toBe("invalid_injection_provenance")
    expect(listObligations(db)).toEqual([])
    expect(() =>
      db
        .prepare(
          `INSERT INTO obligations (entity_id, action, status, doc_id, source_span, injection_suspected) VALUES (?, 'Pay', 'open', ?, '{"start":0,"end":3}', 1)`
        )
        .run(property.id, docA)
    ).toThrow(/CHECK/)
  })
  test("flagged and clean obligations retain their passage flags on both read paths", () => {
    const flagged = insertObligation(
      db,
      obligation({
        injectionSuspected: true,
        injectionReasons: ["fence-tag", "hidden-characters"],
      })
    )
    const clean = insertObligation(
      db,
      obligation({ injectionSuspected: false, injectionReasons: [] })
    )
    expect(
      listObligations(db).map((row) => [
        row.injectionSuspected,
        row.injectionReasons,
      ])
    ).toEqual([
      [true, ["fence-tag", "hidden-characters"]],
      [false, []],
    ])
    expect(getObligationSource(db, flagged)).toMatchObject({
      injectionSuspected: true,
      injectionReasons: ["fence-tag", "hidden-characters"],
    })
    expect(getObligationSource(db, clean)).toMatchObject({
      injectionSuspected: false,
      injectionReasons: [],
    })
    expect(() =>
      db
        .prepare("UPDATE obligations SET injection_suspected = 0 WHERE id = ?")
        .run(flagged)
    ).toThrow(/keeps its source/)
  })
  test("malformed stored reasons are reported instead of returned", () => {
    const id = insertObligation(db, obligation())
    db.exec("DROP TRIGGER obligations_injection_fixed")
    db.exec("PRAGMA ignore_check_constraints = ON")
    db.prepare(
      "UPDATE obligations SET injection_reasons = '[1]' WHERE id = ?"
    ).run(id)
    expect(() => getObligationSource(db, id)).toThrow(/malformed/)
  })
})
