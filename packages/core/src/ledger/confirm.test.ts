import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import {
  confirmExtractionField,
  insertExtraction,
  insertObligation,
  listObligations,
} from "./index"
import { LedgerError } from "./errors"
import { addDocs, ledgerFixture, testDoc } from "./ledger.test-support"
import type { Entity } from "../profile/types"

type TestExtractedFields = Record<
  string,
  {
    raw?: string
    status?: string
    edited?: boolean
    confirmed_at?: string
    confirmed_value?: unknown
    value?: unknown
  }
>

let db: DatabaseSync
let property: Entity
let docA: string

beforeEach(async () => {
  const fixture = await ledgerFixture()
  db = fixture.db
  property = fixture.property
  ;[docA = ""] = addDocs(db, [
    testDoc("a", { entityId: property.id, blobPath: "blobs/a.eml" }),
  ])
})

describe("confirmExtractionField", () => {
  const baseFields = {
    action: { raw: "Pay invoice", span: { start: 0, end: 11 } },
    party: { raw: "Acme Corp", span: { start: 12, end: 21 } },
    amount: {
      raw: "$100.00",
      span: { start: 22, end: 29 },
      status: "parsed" as const,
      value: { amount_minor: 10000, currency: "USD" },
    },
    due_date: {
      raw: "2026-12-01",
      span: { start: 30, end: 40 },
      status: "parsed" as const,
      value: "2026-12-01",
    },
  }

  test("confirms field without editing, sets extraction confirmed when all flagged fields are done", async () => {
    const id = await insertExtraction(db, {
      docId: docA,
      schema: "extracted-fields",
      status: "extracted",
      fields: baseFields,
      confidence: {
        action: 0.95,
        party: 0.95,
        amount: 0.65, // below default 0.8
        due_date: 0.7, // below default 0.8
      },
      model: "test-model",
      createdAt: "2026-11-01T00:00:00.000Z",
    })

    // Confirm amount first
    const res1 = await confirmExtractionField(db, {
      extractionId: id,
      field: "amount",
      now: "2026-11-02T10:00:00.000Z",
    })
    expect(res1.ok).toBe(true)
    expect(res1.confirmedAt).toBe("2026-11-02T10:00:00.000Z")
    expect(res1.extractionConfirmed).toBe(false)
    expect(res1.obligationId).toBeNull()

    // Confirm due_date next -> all flagged fields are now confirmed!
    const res2 = await confirmExtractionField(db, {
      extractionId: id,
      field: "due_date",
      now: "2026-11-02T11:00:00.000Z",
    })
    expect(res2.ok).toBe(true)
    expect(res2.extractionConfirmed).toBe(true)
    expect(res2.obligationId).toBeTypeOf("number")

    // Verify extraction row
    const extRow = db
      .prepare("SELECT confirmed_at, fields_json FROM extractions WHERE id = ?")
      .get(id) as { confirmed_at: string; fields_json: string }
    expect(extRow.confirmed_at).toBe("2026-11-02T11:00:00.000Z")
    const updatedFields = JSON.parse(
      extRow.fields_json
    ) as unknown as TestExtractedFields
    expect(updatedFields["amount"]?.confirmed_at).toBe(
      "2026-11-02T10:00:00.000Z"
    )
    expect(updatedFields["amount"]?.confirmed_value).toEqual({
      amount_minor: 10000,
      currency: "USD",
    })
    expect(updatedFields["due_date"]?.confirmed_at).toBe(
      "2026-11-02T11:00:00.000Z"
    )

    // Verify obligation was created
    const obligations = listObligations(db)
    expect(obligations.length).toBe(1)
    expect(obligations[0]?.action).toBe("Pay invoice")
    expect(obligations[0]?.party).toBe("Acme Corp")
    expect(obligations[0]?.dueAt).toBe("2026-12-01")
  })

  test("confirms with edited amount string or object", async () => {
    const id = await insertExtraction(db, {
      docId: docA,
      schema: "extracted-fields",
      status: "extracted",
      fields: baseFields,
      confidence: {
        action: 0.95,
        party: 0.95,
        amount: 0.5,
        due_date: 0.95,
      },
      model: "test-model",
      createdAt: "2026-11-01T00:00:00.000Z",
    })

    const res = await confirmExtractionField(db, {
      extractionId: id,
      field: "amount",
      value: "$250.50",
    })
    expect(res.ok).toBe(true)
    expect(res.extractionConfirmed).toBe(true)

    const extRow = db
      .prepare("SELECT fields_json FROM extractions WHERE id = ?")
      .get(id) as { fields_json: string }
    const updated = JSON.parse(
      extRow.fields_json
    ) as unknown as TestExtractedFields
    expect(updated["amount"]?.raw).toBe("$250.50")
    expect(updated["amount"]?.edited).toBe(true)
    expect(updated["amount"]?.confirmed_value).toEqual({
      amount_minor: 25050,
      currency: "USD",
    })
  })

  test("confirms with edited amount object", async () => {
    const id = await insertExtraction(db, {
      docId: docA,
      schema: "extracted-fields",
      status: "extracted",
      fields: baseFields,
      confidence: {
        action: 0.95,
        party: 0.95,
        amount: 0.5,
        due_date: 0.95,
      },
      model: "test-model",
      createdAt: "2026-11-01T00:00:00.000Z",
    })

    const res = await confirmExtractionField(db, {
      extractionId: id,
      field: "amount",
      value: { amount_minor: 50000, currency: "EUR" },
    })
    expect(res.ok).toBe(true)

    const extRow = db
      .prepare("SELECT fields_json FROM extractions WHERE id = ?")
      .get(id) as { fields_json: string }
    const updated = JSON.parse(
      extRow.fields_json
    ) as unknown as TestExtractedFields
    expect(updated["amount"]?.edited).toBe(true)
    expect(updated["amount"]?.confirmed_value).toEqual({
      amount_minor: 50000,
      currency: "EUR",
    })
  })

  test("confirms with edited due_date, party, action", async () => {
    const id = await insertExtraction(db, {
      docId: docA,
      schema: "extracted-fields",
      status: "extracted",
      fields: baseFields,
      confidence: {
        action: 0.5,
        party: 0.5,
        amount: 0.95,
        due_date: 0.5,
      },
      model: "test-model",
      createdAt: "2026-11-01T00:00:00.000Z",
    })

    await confirmExtractionField(db, {
      extractionId: id,
      field: "party",
      value: "New Supplier Inc",
    })
    await confirmExtractionField(db, {
      extractionId: id,
      field: "action",
      value: "Review bill",
    })
    const res = await confirmExtractionField(db, {
      extractionId: id,
      field: "due_date",
      value: "2026-12-25",
    })
    expect(res.extractionConfirmed).toBe(true)

    const obligations = listObligations(db)
    expect(obligations[0]?.party).toBe("New Supplier Inc")
    expect(obligations[0]?.action).toBe("Review bill")
    expect(obligations[0]?.dueAt).toBe("2026-12-25")
  })

  test("updates existing obligation if one already existed", async () => {
    // Pre-existing obligation
    await insertObligation(db, {
      entityId: property.id,
      action: "Initial",
      docId: docA,
      span: { start: 0, end: 10 },
      status: "open",
    })

    const id = await insertExtraction(db, {
      docId: docA,
      schema: "extracted-fields",
      status: "extracted",
      fields: baseFields,
      confidence: {
        action: 0.95,
        party: 0.95,
        amount: 0.5,
        due_date: 0.95,
      },
      model: "test-model",
      createdAt: "2026-11-01T00:00:00.000Z",
    })

    const res = await confirmExtractionField(db, {
      extractionId: id,
      field: "amount",
      value: "$300.00",
    })
    expect(res.extractionConfirmed).toBe(true)
    const obligations = listObligations(db)
    expect(obligations.length).toBe(1)
    expect(obligations[0]?.action).toBe("Pay invoice")
  })

  test("rejects invalid amounts and dates", async () => {
    const id = await insertExtraction(db, {
      docId: docA,
      schema: "extracted-fields",
      status: "extracted",
      fields: baseFields,
      confidence: {
        action: 0.95,
        party: 0.95,
        amount: 0.5,
        due_date: 0.5,
      },
      model: "test-model",
      createdAt: "2026-11-01T00:00:00.000Z",
    })

    await expect(
      confirmExtractionField(db, {
        extractionId: id,
        field: "amount",
        value: "not an amount",
      })
    ).rejects.toThrow(LedgerError)

    await expect(
      confirmExtractionField(db, {
        extractionId: id,
        field: "amount",
        value: 12345, // not a string or { amount_minor, currency }
      })
    ).rejects.toThrow(LedgerError)

    await expect(
      confirmExtractionField(db, {
        extractionId: id,
        field: "due_date",
        value: "invalid-date",
      })
    ).rejects.toThrow(LedgerError)

    await expect(
      confirmExtractionField(db, {
        extractionId: id,
        field: "due_date",
        value: 12345,
      })
    ).rejects.toThrow(LedgerError)

    await expect(
      confirmExtractionField(db, {
        extractionId: id,
        field: "party",
        value: "   ",
      })
    ).rejects.toThrow(LedgerError)
  })

  test("rejects unknown extraction or empty extraction", async () => {
    await expect(
      confirmExtractionField(db, {
        extractionId: 9999,
        field: "amount",
      })
    ).rejects.toMatchObject({ code: "extraction_not_found" })

    const emptyId = await insertExtraction(db, {
      docId: docA,
      schema: "extracted-fields",
      status: "processed_empty",
      model: "none",
      createdAt: "2026-11-01T00:00:00.000Z",
    })
    await expect(
      confirmExtractionField(db, {
        extractionId: emptyId,
        field: "amount",
      })
    ).rejects.toMatchObject({ code: "invalid_status" })
  })

  test("rejects missing field in extraction", async () => {
    const id = await insertExtraction(db, {
      docId: docA,
      schema: "extracted-fields",
      status: "extracted",
      fields: {
        action: { raw: "Pay invoice", span: { start: 0, end: 11 } },
      },
      confidence: {
        action: 0.95,
      },
      model: "test-model",
      createdAt: "2026-11-01T00:00:00.000Z",
    })

    await expect(
      confirmExtractionField(db, {
        extractionId: id,
        field: "amount",
      })
    ).rejects.toMatchObject({ code: "field_not_found" })
  })
})
