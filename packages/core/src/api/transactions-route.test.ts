import type { DatabaseSync } from "node:sqlite"
import type { CoreApiError, CoreApiTransactionList } from "@eido/schemas"
import { beforeEach, describe, expect, test } from "vitest"
import { openIndex } from "../index/schema"
import { insertLinks, insertObligation } from "../ledger"
import { addDocs, ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"
import { listTransactionsRoute } from "./transactions-route"

let db: DatabaseSync
let handle: ApiHandler
let propertyId: string
let companyId: string

function addAccount(id: string, name: string): void {
  db.prepare(
    "INSERT INTO accounts (id, connector, name, currency) VALUES (?, 'simplefin', ?, 'USD')"
  ).run(id, name)
}

function addTransaction(
  id: string,
  accountId: string,
  entityId: string,
  postedAt: string,
  amountCents: number,
  description = "Example Co."
): void {
  db.prepare(
    `INSERT INTO transactions
       (id, account_id, entity_id, posted_at, amount_cents, currency, description, raw_json, ingested_at)
     VALUES (?, ?, ?, ?, ?, 'USD', ?, '{}', '2026-10-18T00:00:00.000Z')`
  ).run(id, accountId, entityId, postedAt, amountCents, description)
}

beforeEach(async () => {
  const fixture = await ledgerFixture()
  db = fixture.db
  propertyId = fixture.property.id
  companyId = fixture.company.id
  handle = createApiHandler({
    profile: fixture.profile,
    allowedHosts: ["core.test"],
    documents: { db },
  })
  addAccount("acct-chk", "Checking")
  addAccount("acct-biz", "Business")
  addAccount("acct-empty", "Dormant")
  addTransaction(
    "acct-chk:1",
    "acct-chk",
    propertyId,
    "2026-10-01T00:00:00.000Z",
    185000,
    "Rent"
  )
  addTransaction(
    "acct-chk:2",
    "acct-chk",
    propertyId,
    "2026-10-17T00:00:00.000Z",
    -8412,
    "Power"
  )
  addTransaction(
    "acct-biz:1",
    "acct-biz",
    companyId,
    "2026-10-15T00:00:00.000Z",
    200000,
    "Client"
  )
})

async function get(query = ""): Promise<Response> {
  return handle(new Request(`http://core.test/transactions${query}`))
}

async function list(query = ""): Promise<CoreApiTransactionList> {
  const response = await get(query)
  expect(response.status).toBe(200)
  return (await response.json()) as CoreApiTransactionList
}

describe("GET /transactions", () => {
  test("lists newest first with the stored amount, account and entity", async () => {
    const body = await list()
    expect(body.transactions.map((t) => t.id)).toEqual([
      "acct-chk:2",
      "acct-biz:1",
      "acct-chk:1",
    ])
    expect(body.transactions[0]).toEqual({
      id: "acct-chk:2",
      postedAt: "2026-10-17T00:00:00.000Z",
      description: "Power",
      amountCents: -8412,
      currency: "USD",
      account: { id: "acct-chk", name: "Checking" },
      entity: { id: propertyId, name: "Test Property", tag: "PROP" },
      linkedObligation: null,
    })
    expect(body.nextOffset).toBeNull()
  })

  test("filters by entity", async () => {
    const body = await list(`?entity=${companyId}`)
    expect(body.transactions.map((t) => t.id)).toEqual(["acct-biz:1"])
  })

  test("filters by account", async () => {
    const body = await list("?account=acct-chk")
    expect(body.transactions.map((t) => t.id)).toEqual([
      "acct-chk:2",
      "acct-chk:1",
    ])
  })

  test("combines the entity and account filters", async () => {
    const body = await list(`?entity=${companyId}&account=acct-chk`)
    expect(body.transactions).toEqual([])
  })

  test("lists the accounts that hold transactions whatever the filters", async () => {
    const body = await list(`?entity=${companyId}`)
    expect(body.accounts).toEqual([
      { id: "acct-biz", name: "Business" },
      { id: "acct-chk", name: "Checking" },
    ])
  })

  test("pages with nextOffset and never repeats a row", async () => {
    const first = await list("?limit=2")
    expect(first.transactions.map((t) => t.id)).toEqual([
      "acct-chk:2",
      "acct-biz:1",
    ])
    expect(first.nextOffset).toBe(2)
    const second = await list("?limit=2&offset=2")
    expect(second.transactions.map((t) => t.id)).toEqual(["acct-chk:1"])
    expect(second.nextOffset).toBeNull()
  })

  test("orders rows posted at the same time by id", async () => {
    addTransaction(
      "acct-chk:3",
      "acct-chk",
      propertyId,
      "2026-10-17T00:00:00.000Z",
      -100
    )
    const body = await list()
    expect(body.transactions.slice(0, 2).map((t) => t.id)).toEqual([
      "acct-chk:3",
      "acct-chk:2",
    ])
  })

  test("is empty with no stored transactions", async () => {
    db.exec("DELETE FROM transactions")
    expect(await list()).toEqual({
      transactions: [],
      accounts: [],
      nextOffset: null,
    })
  })

  async function addObligation(entityId: string, action: string) {
    const [docId = ""] = addDocs(db, [testDoc(action, { entityId })])
    return insertObligation(db, {
      entityId,
      action,
      dueAt: "2026-10-20",
      status: "open",
      docId,
      span: { start: 0, end: 4 },
    })
  }

  async function pays(transactionId: string, obligationId: number) {
    await insertLinks(db, [
      {
        src: `txn:${transactionId}`,
        dst: `obl:${obligationId}`,
        kind: "pays",
        confidence: 0.9,
        origin: "match",
      },
    ])
  }

  test("returns the obligation a transaction paid and null for the others", async () => {
    const id = await addObligation(propertyId, "Pay the power bill")
    await pays("acct-chk:2", id)
    const body = await list()
    expect(body.transactions.map((t) => [t.id, t.linkedObligation])).toEqual([
      ["acct-chk:2", { id, action: "Pay the power bill" }],
      ["acct-biz:1", null],
      ["acct-chk:1", null],
    ])
  })

  test("leaves out a link to an obligation of another entity", async () => {
    const id = await addObligation(companyId, "Pay the client refund")
    await pays("acct-chk:2", id)
    const body = await list("?account=acct-chk")
    expect(body.transactions[0]?.linkedObligation).toBeNull()
  })

  test("rejects a bad limit with a field error", async () => {
    const response = await get("?limit=0")
    expect(response.status).toBe(422)
    const body = (await response.json()) as CoreApiError
    expect(body.error.fields).toEqual([
      { field: "limit", message: "must be an integer from 1 to 200" },
    ])
  })

  test("serves GET only", async () => {
    const response = await handle(
      new Request("http://core.test/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
  })
})

describe("GET /transactions before the ledger is applied", () => {
  test("lists transactions with no linked obligation", () => {
    const index = openIndex(":memory:")
    index.exec(`
      INSERT INTO entities (id, kind, name, tag, created_at)
        VALUES ('ent-home', 'personal', 'Home', 'HOME', '2026-01-01T00:00:00Z');
      INSERT INTO accounts (id, connector, name, currency) VALUES ('acct', 'simplefin', 'Everyday', 'USD');
      INSERT INTO transactions
        (id, account_id, entity_id, posted_at, amount_cents, currency, description, raw_json, ingested_at)
        VALUES ('acct:1', 'acct', 'ent-home', '2026-10-01T00:00:00.000Z', -500, 'USD', 'Lorem', '{}', '2026-10-02T00:00:00.000Z');`)
    const result = listTransactionsRoute(index, new URLSearchParams())
    expect(
      result.ok ? result.body.transactions.map((t) => t.linkedObligation) : []
    ).toEqual([null])
  })
})

describe("GET /transactions without the data DB", () => {
  test("is not served", async () => {
    const fixture = await ledgerFixture()
    const bare = createApiHandler({
      profile: fixture.profile,
      allowedHosts: ["core.test"],
    })
    const response = await bare(new Request("http://core.test/transactions"))
    expect(response.status).toBe(404)
  })
})
