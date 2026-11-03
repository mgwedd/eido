import { describe, expect, it } from "vitest"
import { openIndex } from "../../index/schema"
import * as facadeModule from "./facade"
import * as connectorModule from "./index"
import { createSimpleFinFacade } from "./facade"

// Invariant 4: the bank connector reads; nothing it exports writes to the bank, moves money or
// deletes. The ledger rows below are synthetic.

const FORBIDDEN =
  /write|transfer|pay|send|delete|remove|charge|debit|credit|withdraw|deposit|execute|submit|^post|update|mutate|move|approve/i

describe("SimpleFIN read verbs", () => {
  it("export no verb that writes, transfers or pays", () => {
    const db = openIndex(":memory:")
    expect(Object.keys(createSimpleFinFacade(db)).sort()).toEqual([
      "listAccounts",
      "listTransactions",
    ])
    expect(Object.keys(facadeModule)).toEqual(["createSimpleFinFacade"])
    expect(
      Object.keys(connectorModule).filter((name) => FORBIDDEN.test(name))
    ).toEqual([])
  })

  it("list stored accounts and filter transactions by account, entity and limit", () => {
    const db = openIndex(":memory:")
    db.exec(`
      INSERT INTO entities (id, kind, name, tag, created_at) VALUES
        ('ent_a', 'personal', 'A', 'A', '2026-01-01T00:00:00Z'),
        ('ent_b', 'company', 'B', 'B', '2026-01-01T00:00:00Z');
      INSERT INTO accounts (id, connector, name, currency, entity_id, balance_cents, balance_at) VALUES
        ('acc_1', 'simplefin', 'Lorem', 'USD', 'ent_a', 1050, '2026-02-01T00:00:00.000Z'),
        ('acc_2', 'simplefin', 'Ipsum', 'USD', 'ent_b', NULL, NULL),
        ('acc_3', 'other', 'Dolor', 'USD', 'ent_a', 1, NULL);
      INSERT INTO transactions (id, account_id, entity_id, posted_at, amount_cents, currency, description, category, raw_json, ingested_at) VALUES
        ('acc_1:t1', 'acc_1', 'ent_a', '2026-02-01T00:00:00.000Z', -1230, 'USD', 'one', NULL, '{}', 'x'),
        ('acc_1:t2', 'acc_1', 'ent_a', '2026-02-03T00:00:00.000Z', 7, 'USD', 'two', 'food', '{}', 'x'),
        ('acc_2:t3', 'acc_2', 'ent_b', '2026-02-02T00:00:00.000Z', 500, 'USD', 'three', NULL, '{}', 'x'),
        ('acc_3:t4', 'acc_3', 'ent_a', '2026-02-04T00:00:00.000Z', 1, 'USD', 'other', NULL, '{}', 'x');`)
    const facade = createSimpleFinFacade(db)
    expect(facade.listAccounts()).toEqual([
      {
        id: "acc_2",
        name: "Ipsum",
        currency: "USD",
        entityId: "ent_b",
        balanceCents: null,
        balanceAt: null,
      },
      {
        id: "acc_1",
        name: "Lorem",
        currency: "USD",
        entityId: "ent_a",
        balanceCents: 1050,
        balanceAt: "2026-02-01T00:00:00.000Z",
      },
    ])
    const ids = (filter?: Parameters<typeof facade.listTransactions>[0]) =>
      facade.listTransactions(filter).map((row) => row.id)
    expect(ids()).toEqual(["acc_1:t2", "acc_2:t3", "acc_1:t1"])
    expect(ids({ accountId: "acc_1" })).toEqual(["acc_1:t2", "acc_1:t1"])
    expect(ids({ entityId: "ent_b" })).toEqual(["acc_2:t3"])
    expect(ids({ limit: 1 })).toEqual(["acc_1:t2"])
    expect(facade.listTransactions({ accountId: "acc_1", limit: 1 })).toEqual([
      {
        id: "acc_1:t2",
        accountId: "acc_1",
        entityId: "ent_a",
        postedAt: "2026-02-03T00:00:00.000Z",
        amountCents: 7,
        currency: "USD",
        description: "two",
        category: "food",
      },
    ])
  })
})
