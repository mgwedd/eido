import { describe, expect, it } from "vitest"
import { openIndex } from "../../index/schema"
import { createSimpleFinClient, type SimpleFinResponse } from "./client"
import { syncSimpleFin } from "./sync"

describe("syncSimpleFin", () => {
  it("stores accounts, parses amounts to integer cents, and assigns entity_id", async () => {
    const db = openIndex(":memory:")
    db.prepare(`
      INSERT INTO entities (id, kind, name, tag, created_at)
      VALUES
        ('ent_personal', 'personal', 'Personal', 'PERS', '2026-01-01T00:00:00Z'),
        ('ent_business', 'company', 'Business LLC', 'BIZ', '2026-01-01T00:00:00Z')
    `).run()

    const syntheticResponse: SimpleFinResponse = {
      accounts: [
        {
          id: "acc_checking",
          name: "Personal Checking",
          currency: "USD",
          balance: "1234.56",
          "balance-date": 1730000000,
          transactions: [
            {
              id: "tx_1",
              posted: 1730000010,
              amount: "-12.30",
              description: "Coffee Shop",
            },
            {
              id: "tx_2",
              posted: 1730000020,
              amount: "0.07",
              description: "Interest Payment",
            },
            {
              id: "tx_3_malformed",
              posted: 1730000030,
              amount: "12.345", // Malformed: more than 2 decimals
              description: "Bad Amount Item",
            },
            {
              id: "tx_4_pending",
              posted: 0, // Pending
              amount: "-25.00",
              description: "Pending Charge",
            },
          ],
        },
        {
          id: "acc_savings_unassigned",
          name: "Unassigned Savings",
          currency: "USD",
          balance: "5000.00",
          "balance-date": 1730000000,
          transactions: [
            {
              id: "tx_unassigned_1",
              posted: 1730000050,
              amount: "100.00",
              description: "Deposit",
            },
          ],
        },
      ],
      errors: [
        "Connection note: see https://bridge.simplefin.org/help for details",
      ],
    }

    const client = createSimpleFinClient({
      fetch: () => Promise.resolve(Response.json(syntheticResponse)),
    })

    const result = await syncSimpleFin({
      db,
      client,
      entityAssignments: {
        acc_checking: "ent_personal",
      },
      now: () => 1730050000 * 1000,
    })

    expect(result.accountsStored).toBe(2)
    // 2 valid posted transactions stored for acc_checking; tx_3 malformed rejected, tx_4 pending skipped, unassigned account transactions not stored
    expect(result.transactionsStored).toBe(2)
    expect(result.unassignedAccounts).toBe(1)
    expect(result.malformedAmountsRejected).toBe(1)
    expect(result.healthMessages).toEqual([
      "Connection note: see [url] for details",
      "1 account needs an entity",
    ])

    // Verify stored accounts
    const accounts = db
      .prepare("SELECT * FROM accounts ORDER BY id")
      .all() as Record<string, unknown>[]
    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toMatchObject({
      id: "acc_checking",
      connector: "simplefin",
      name: "Personal Checking",
      currency: "USD",
      entity_id: "ent_personal",
      balance_cents: 123456,
    })
    expect(accounts[1]).toMatchObject({
      id: "acc_savings_unassigned",
      connector: "simplefin",
      name: "Unassigned Savings",
      currency: "USD",
      entity_id: null,
      balance_cents: 500000,
    })

    // Verify stored transactions
    const txs = db
      .prepare("SELECT * FROM transactions ORDER BY id")
      .all() as Record<string, unknown>[]
    expect(txs).toHaveLength(2)
    expect(txs[0]).toMatchObject({
      id: "acc_checking:tx_1",
      account_id: "acc_checking",
      entity_id: "ent_personal",
      amount_cents: -1230,
      currency: "USD",
      description: "Coffee Shop",
    })
    expect(txs[1]).toMatchObject({
      id: "acc_checking:tx_2",
      account_id: "acc_checking",
      entity_id: "ent_personal",
      amount_cents: 7,
      currency: "USD",
      description: "Interest Payment",
    })

    // Check that transactions of unassigned account are NOT stored
    const unassignedTxs = db
      .prepare(
        "SELECT * FROM transactions WHERE account_id = 'acc_savings_unassigned'"
      )
      .all()
    expect(unassignedTxs).toHaveLength(0)

    // Check cursor advancement
    const cursor = db
      .prepare(
        "SELECT * FROM cursors WHERE connector = 'simplefin' AND stream = 'transactions'"
      )
      .get() as Record<string, unknown>
    expect(cursor).toBeDefined()
    expect(cursor["cursor"]).toBe("1730050000")
  })

  it("is idempotent: re-running over the same window creates no duplicates", async () => {
    const db = openIndex(":memory:")
    db.prepare(`
      INSERT INTO entities (id, kind, name, tag, created_at)
      VALUES ('ent_1', 'personal', 'Personal', 'PERS', '2026-01-01T00:00:00Z')
    `).run()

    const syntheticResponse: SimpleFinResponse = {
      accounts: [
        {
          id: "acc_1",
          name: "Checking",
          currency: "USD",
          balance: "100.00",
          "balance-date": 1730000000,
          transactions: [
            {
              id: "tx_100",
              posted: 1730000010,
              amount: "-50.00",
              description: "Grocery",
            },
          ],
        },
      ],
    }

    const client = createSimpleFinClient({
      fetch: () => Promise.resolve(Response.json(syntheticResponse)),
    })

    const runSync = () =>
      syncSimpleFin({
        db,
        client,
        entityAssignments: { acc_1: "ent_1" },
        now: () => 1730050000 * 1000,
      })

    // First run
    await runSync()
    let txCount = db
      .prepare("SELECT count(*) as c FROM transactions")
      .get() as { c: number }
    let accCount = db.prepare("SELECT count(*) as c FROM accounts").get() as {
      c: number
    }
    expect(txCount.c).toBe(1)
    expect(accCount.c).toBe(1)

    // Re-run over the same window
    await runSync()
    txCount = db.prepare("SELECT count(*) as c FROM transactions").get() as {
      c: number
    }
    accCount = db.prepare("SELECT count(*) as c FROM accounts").get() as {
      c: number
    }
    expect(txCount.c).toBe(1)
    expect(accCount.c).toBe(1)
  })

  it("does not advance cursor if the sync batch fails", async () => {
    const db = openIndex(":memory:")

    const failingClient: SimpleFinClient = {
      getAccounts: () => Promise.reject(new Error("Network timeout")),
    }

    await expect(
      syncSimpleFin({
        db,
        client: failingClient,
        now: () => 1730050000 * 1000,
      })
    ).rejects.toThrow("Network timeout")

    const cursor = db
      .prepare(
        "SELECT * FROM cursors WHERE connector = 'simplefin' AND stream = 'transactions'"
      )
      .get()
    expect(cursor).toBeUndefined()
  })
})
