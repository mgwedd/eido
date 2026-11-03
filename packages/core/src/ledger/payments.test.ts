import type { DatabaseSync } from "node:sqlite"
import type { ExtractedFields } from "@eido/schemas"
import { beforeEach, describe, expect, test } from "vitest"
import { openIndex } from "../index/schema"
import type { Entity } from "../profile/types"
import {
  insertExtraction,
  insertLinks,
  insertObligation,
  linkPayments,
  linksFor,
  matchPayments,
} from "./index"
import type {
  ObligationInput,
  PayableObligation,
  PaymentTransaction,
} from "./index"
import { addDocs, ledgerFixture, testDoc } from "./ledger.test-support"

// Synthetic entities, amounts and descriptions only.

const txn = (over: Partial<PaymentTransaction> = {}): PaymentTransaction => ({
  id: "acc:1",
  entityId: "ent-a",
  postedAt: "2030-03-05T15:00:00.000Z",
  amountCents: -12000,
  currency: "USD",
  ...over,
})

const bill = (over: Partial<PayableObligation> = {}): PayableObligation => ({
  id: 1,
  entityId: "ent-a",
  dueAt: "2030-03-10",
  amountMinor: 12000,
  currency: "USD",
  ...over,
})

const paid = (src: string, dst: string) => ({
  src,
  dst,
  kind: "pays",
  confidence: 0.9,
  origin: "match",
})

describe("matchPayments", () => {
  test("a debit of the bill's amount near its due date pays it", () => {
    expect(matchPayments([txn()], [bill()])).toEqual([
      paid("txn:acc:1", "obl:1"),
    ])
  })

  test.each([
    ["30 days before the due date", "2030-02-08T00:00:00.000Z", true],
    ["31 days before the due date", "2030-02-07T23:59:59.000Z", false],
    ["7 days after the due date", "2030-03-17T23:00:00.000Z", true],
    ["8 days after the due date", "2030-03-18T00:00:00.000Z", false],
  ])("a debit posted %s links: %s", (_, postedAt, links) => {
    expect(matchPayments([txn({ postedAt })], [bill()])).toHaveLength(
      links ? 1 : 0
    )
  })

  test.each([
    ["another entity", txn({ entityId: "ent-b" })],
    ["another currency", txn({ currency: "EUR" })],
    ["another amount", txn({ amountCents: -12001 })],
    ["a credit of the same amount", txn({ amountCents: 12000 })],
  ])("a transaction in %s pays nothing", (_, transaction) => {
    expect(matchPayments([transaction], [bill()])).toEqual([])
  })

  test("two bills a debit could pay give no link", () => {
    expect(
      matchPayments([txn()], [bill(), bill({ id: 2, dueAt: "2030-03-12" })])
    ).toEqual([])
  })

  test("two debits that could pay one bill give no link", () => {
    expect(
      matchPayments(
        [txn(), txn({ id: "acc:2", postedAt: "2030-03-06T00:00:00.000Z" })],
        [bill()]
      )
    ).toEqual([])
  })

  test("an ambiguous pair leaves an unambiguous one linked", () => {
    const links = matchPayments(
      [txn(), txn({ id: "acc:2" }), txn({ id: "acc:3", amountCents: -5000 })],
      [bill(), bill({ id: 2, amountMinor: 5000 })]
    )
    expect(links).toEqual([paid("txn:acc:3", "obl:2")])
  })
})

describe("linkPayments", () => {
  let db: DatabaseSync
  let property: Entity
  let company: Entity
  let doc = 0

  const FIELDS: ExtractedFields = {
    action: { raw: "Pay the invoice", span: { start: 0, end: 5 } },
    amount: {
      raw: "USD 120.00",
      span: { start: 6, end: 16 },
      status: "parsed",
      value: { amount_minor: 12000, currency: "USD" },
    },
  }

  /** A document with one extraction of `fields`, and an obligation on it. */
  async function addBill(
    over: Partial<ObligationInput> & { undated?: true } = {},
    fields: ExtractedFields = FIELDS
  ): Promise<number> {
    const { undated, ...input } = over
    doc++
    const entityId = input.entityId ?? property.id
    const [docId = ""] = addDocs(db, [
      testDoc(`bill-${String(doc)}`, { entityId }),
    ])
    await insertExtraction(db, {
      docId,
      schema: "extracted-fields",
      status: "extracted",
      fields,
      confidence: { action: 0.9, amount: 0.9 },
      model: "local-test-model",
      createdAt: "2030-03-01T00:00:00.000Z",
    })
    return insertObligation(db, {
      entityId,
      action: "Pay the invoice",
      ...(undated === true ? {} : { dueAt: "2030-03-10" }),
      status: "open",
      docId,
      span: { start: 0, end: 5 },
      ...input,
    })
  }

  function addTransaction(
    id: string,
    amountCents: number,
    entityId = property.id
  ): void {
    db.prepare(
      `INSERT INTO transactions
         (id, account_id, entity_id, posted_at, amount_cents, currency, description, raw_json, ingested_at)
       VALUES (?, 'acc', ?, '2030-03-05T00:00:00.000Z', ?, 'USD', 'Lorem', '{}', '2030-03-06T00:00:00.000Z')`
    ).run(id, entityId, amountCents)
  }

  beforeEach(async () => {
    ;({ db, property, company } = await ledgerFixture())
    db.prepare(
      "INSERT INTO accounts (id, connector, name, currency) VALUES ('acc', 'simplefin', 'Everyday', 'USD')"
    ).run()
  })

  test("stores a pays link from the debit to the bill it paid", async () => {
    const id = await addBill()
    addTransaction("acc:1", -12000)
    expect(await linkPayments(db)).toBe(1)
    expect(linksFor(db, `obl:${id}`)).toEqual([
      paid("txn:acc:1", `obl:${id}`),
    ])
  })

  test("a second run leaves a linked pair alone and does not link it again elsewhere", async () => {
    await addBill()
    addTransaction("acc:1", -12000)
    await linkPayments(db)
    // A second debit of the same amount: the bill is already paid, so it is no candidate.
    addTransaction("acc:2", -12000)
    expect(await linkPayments(db)).toBe(0)
    expect(linksFor(db, "txn:acc:2")).toEqual([])
  })

  test("an obligation made after its payment is linked on the next run", async () => {
    addTransaction("acc:1", -12000)
    expect(await linkPayments(db)).toBe(0)
    const id = await addBill()
    expect(await linkPayments(db)).toBe(1)
    expect(linksFor(db, "txn:acc:1")).toEqual([
      paid("txn:acc:1", `obl:${id}`),
    ])
  })

  test("reads the amount from the document's latest extraction", async () => {
    const id = await addBill()
    const [docId = ""] = db
      .prepare("SELECT doc_id FROM obligations WHERE id = ?")
      .all(id)
      .map((row) => String(row["doc_id"]))
    await insertExtraction(db, {
      docId,
      schema: "extracted-fields",
      status: "extracted",
      fields: {
        ...FIELDS,
        amount: {
          raw: "USD 95.00",
          span: { start: 6, end: 15 },
          status: "parsed",
          value: { amount_minor: 9500, currency: "USD" },
        },
      },
      confidence: { action: 0.9, amount: 0.9 },
      model: "local-test-model",
      createdAt: "2030-03-02T00:00:00.000Z",
    })
    addTransaction("acc:1", -12000)
    addTransaction("acc:2", -9500)
    expect(await linkPayments(db)).toBe(1)
    expect(linksFor(db, "txn:acc:2")).toEqual([
      paid("txn:acc:2", `obl:${id}`),
    ])
  })

  test.each([
    ["dismissed", { status: "dismissed" }, FIELDS],
    ["a reply to send", { direction: "owed" }, FIELDS],
    [
      "without a parsed amount",
      {},
      {
        ...FIELDS,
        amount: {
          raw: "lorem",
          span: { start: 6, end: 11 },
          status: "parse_failed",
          value: null,
        },
      },
    ],
  ] satisfies [string, Partial<ObligationInput>, ExtractedFields][])(
    "a bill %s is not linked",
    async (_, over, fields) => {
      await addBill(over, fields)
      addTransaction("acc:1", -12000)
      expect(await linkPayments(db)).toBe(0)
    }
  )

  test("a bill with no due date is not linked", async () => {
    await addBill({ undated: true })
    addTransaction("acc:1", -12000)
    expect(await linkPayments(db)).toBe(0)
  })

  test("a debit of another entity does not pay the bill", async () => {
    await addBill()
    addTransaction("acc:1", -12000, company.id)
    expect(await linkPayments(db)).toBe(0)
  })

  test("does nothing on a database without the ledger", async () => {
    const index = openIndex(":memory:")
    expect(await linkPayments(index)).toBe(0)
  })
})

describe("the links table holds pays edges", () => {
  test("a pays link needs a stored transaction and goes from txn: to obl:", async () => {
    const { db, property } = await ledgerFixture()
    const [docId = ""] = addDocs(db, [
      testDoc("bill", { entityId: property.id }),
    ])
    const id = await insertObligation(db, {
      entityId: property.id,
      action: "Pay",
      status: "open",
      docId,
      span: { start: 0, end: 3 },
    })
    await expect(
      insertLinks(db, [
        {
          src: "txn:acc:missing",
          dst: `obl:${id}`,
          kind: "pays",
          confidence: 0.9,
          origin: "match",
        },
      ])
    ).rejects.toThrow(/link endpoint does not exist/)
    await expect(
      insertLinks(db, [
        {
          src: `doc:${docId}`,
          dst: `obl:${id}`,
          kind: "pays",
          confidence: 0.9,
          origin: "match",
        },
      ])
    ).rejects.toThrow(/CHECK/)
  })
})
