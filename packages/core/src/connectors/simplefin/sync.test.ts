import { describe, expect, it, vi } from "vitest"
import type { DatabaseSync } from "node:sqlite"
import { openIndex } from "../../index/schema"
import { parseAccountSet, SimpleFinError } from "./client"
import type { GetAccountsParams, SimpleFinClient } from "./client"
import { CURSOR_OVERLAP_SECONDS, healthMessages, syncSimpleFin } from "./sync"

// Synthetic accounts, amounts and descriptions only.

const NOW_MS = Date.parse("2026-03-01T00:00:00.000Z")
const NOW = NOW_MS / 1000
const DAY = 86_400
const POSTED = Date.parse("2026-02-20T12:00:00.000Z") / 1000

function ledger(): DatabaseSync {
  const db = openIndex(":memory:")
  db.exec(`
    INSERT INTO entities (id, kind, name, tag, created_at) VALUES
      ('ent_home', 'personal', 'Home', 'HOME', '2026-01-01T00:00:00Z'),
      ('ent_shop', 'company', 'Shop Co', 'SHOP', '2026-01-01T00:00:00Z')`)
  return db
}

const ACCOUNT_SET = {
  errors: ["Bridge note: see https://help.example.invalid/x?token=abc", 7],
  accounts: [
    {
      id: "acc_chk",
      name: "Everyday",
      currency: "USD",
      balance: "1234.56",
      "balance-date": POSTED,
      transactions: [
        {
          id: "tx_1",
          posted: POSTED,
          amount: "-12.30",
          description: "Lorem cafe",
        },
        {
          id: "tx_2",
          posted: POSTED + 60,
          amount: "0.07",
          description: "Ipsum interest",
        },
        {
          id: "tx_3",
          posted: POSTED + 120,
          amount: "12.345",
          description: "Dolor",
        },
        {
          id: "tx_4",
          posted: 0,
          amount: "-25.00",
          description: "Sit",
          pending: true,
        },
        {
          id: "tx_5",
          posted: POSTED + 180,
          amount: "-1.00",
          description: "Amet",
          pending: true,
        },
        { id: "tx_6", posted: POSTED, amount: "-3.00" },
      ],
    },
    {
      id: "acc_sav",
      name: "Rainy day",
      currency: "USD",
      balance: "50.00",
      transactions: [
        {
          id: "tx_9",
          posted: POSTED,
          amount: "100.00",
          description: "Consectetur",
        },
      ],
    },
    {
      id: "acc_biz",
      name: "Shop card",
      currency: "EUR",
      balance: "oops",
      transactions: [
        {
          id: "tx_8",
          posted: POSTED,
          amount: "5.00",
          description: "Adipiscing",
        },
      ],
    },
  ],
}

function stubClient(
  answer: (params: GetAccountsParams, call: number) => unknown
): SimpleFinClient & { calls: GetAccountsParams[] } {
  const calls: GetAccountsParams[] = []
  return {
    calls,
    getAccounts: vi.fn((params: GetAccountsParams = {}) => {
      calls.push(params)
      try {
        return Promise.resolve(parseAccountSet(answer(params, calls.length)))
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error("stub")
        )
      }
    }),
  }
}

const ASSIGNMENTS = { acc_chk: "ent_home", acc_biz: "ent_gone" }

function transactions(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT id, account_id, entity_id, posted_at, amount_cents, currency, description FROM transactions ORDER BY id"
    )
    .all()
}

function cursor(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT cursor, updated_at FROM cursors WHERE connector = 'simplefin' AND stream = 'transactions'"
    )
    .get()
}

describe("syncSimpleFin", () => {
  it("tags every stored transaction with its account's entity and stores amounts as integer cents", async () => {
    const db = ledger()
    const result = await syncSimpleFin({
      db,
      client: stubClient(() => ACCOUNT_SET),
      assignments: ASSIGNMENTS,
      now: () => NOW_MS,
    })
    expect(transactions(db)).toEqual([
      {
        id: "acc_chk:tx_1",
        account_id: "acc_chk",
        entity_id: "ent_home",
        posted_at: "2026-02-20T12:00:00.000Z",
        amount_cents: -1230,
        currency: "USD",
        description: "Lorem cafe",
      },
      {
        id: "acc_chk:tx_2",
        account_id: "acc_chk",
        entity_id: "ent_home",
        posted_at: "2026-02-20T12:01:00.000Z",
        amount_cents: 7,
        currency: "USD",
        description: "Ipsum interest",
      },
    ])
    expect(result).toEqual({
      windows: 1,
      accounts: 3,
      transactionsStored: 2,
      // An account with no entity (acc_sav) and one assigned to an entity that does not exist.
      unassignedAccounts: 2,
      // 12.345 is malformed; tx_6 has no description.
      rejectedTransactions: 2,
      cursor: NOW,
      messages: ["2 accounts need an entity", "Bridge note: see [url]"],
    })
  })

  it("keeps accounts without an entity visible but stores none of their transactions", async () => {
    const db = ledger()
    await syncSimpleFin({
      db,
      client: stubClient(() => ACCOUNT_SET),
      assignments: ASSIGNMENTS,
      now: () => NOW_MS,
    })
    expect(
      db
        .prepare(
          "SELECT id, connector, name, currency, entity_id, balance_cents, balance_at FROM accounts ORDER BY id"
        )
        .all()
    ).toEqual([
      {
        id: "acc_biz",
        connector: "simplefin",
        name: "Shop card",
        currency: "EUR",
        entity_id: null,
        balance_cents: null,
        balance_at: null,
      },
      {
        id: "acc_chk",
        connector: "simplefin",
        name: "Everyday",
        currency: "USD",
        entity_id: "ent_home",
        balance_cents: 123456,
        balance_at: "2026-02-20T12:00:00.000Z",
      },
      {
        id: "acc_sav",
        connector: "simplefin",
        name: "Rainy day",
        currency: "USD",
        entity_id: null,
        balance_cents: 5000,
        balance_at: null,
      },
    ])
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM transactions WHERE account_id <> 'acc_chk'"
        )
        .get()
    ).toEqual({ n: 0 })
  })

  it("re-reading the same window creates no duplicates and starts from the cursor less the overlap", async () => {
    const db = ledger()
    const client = stubClient(() => ACCOUNT_SET)
    const options = { db, client, assignments: ASSIGNMENTS }
    await syncSimpleFin({ ...options, now: () => NOW_MS })
    const later = NOW_MS + 3_600_000
    const second = await syncSimpleFin({ ...options, now: () => later })
    expect(second.transactionsStored).toBe(2)
    expect(transactions(db).map((row) => row["id"])).toEqual([
      "acc_chk:tx_1",
      "acc_chk:tx_2",
    ])
    expect(client.calls).toEqual([
      { startDate: NOW - 90 * DAY, endDate: NOW },
      { startDate: NOW - CURSOR_OVERLAP_SECONDS, endDate: NOW + 3600 },
    ])
    expect(cursor(db)).toEqual({
      cursor: String(NOW + 3600),
      updated_at: "2026-03-01T01:00:00.000Z",
    })
  })

  it("splits the first read into windows no larger than the configured range", async () => {
    const db = ledger()
    const client = stubClient(() => ({ accounts: [] }))
    const result = await syncSimpleFin({
      db,
      client,
      assignments: {},
      config: { maxDateRangeDays: 40 },
      now: () => NOW_MS,
    })
    expect(client.calls).toEqual([{ startDate: NOW - 40 * DAY, endDate: NOW }])
    expect(result.windows).toBe(1)

    // A cursor 100 days old needs three 40-day windows (less the 3-day overlap: 103 days).
    db.prepare("UPDATE cursors SET cursor = ?").run(String(NOW - 100 * DAY))
    client.calls.length = 0
    const caughtUp = await syncSimpleFin({
      db,
      client,
      assignments: {},
      config: { maxDateRangeDays: 40 },
      now: () => NOW_MS,
    })
    expect(client.calls).toEqual([
      { startDate: NOW - 103 * DAY, endDate: NOW - 63 * DAY },
      { startDate: NOW - 63 * DAY, endDate: NOW - 23 * DAY },
      { startDate: NOW - 23 * DAY, endDate: NOW },
    ])
    expect(caughtUp.windows).toBe(3)
  })

  it("moves the cursor only past a window that was stored", async () => {
    const db = ledger()
    db.prepare(
      "INSERT INTO cursors (connector, stream, cursor, updated_at) VALUES ('simplefin', 'transactions', ?, 'x')"
    ).run(String(NOW - 120 * DAY))
    const client = stubClient((_params, call) => {
      if (call === 2) throw new SimpleFinError("daily_limit", "spent")
      return ACCOUNT_SET
    })
    await expect(
      syncSimpleFin({ db, client, assignments: ASSIGNMENTS, now: () => NOW_MS })
    ).rejects.toThrow("spent")
    expect(cursor(db)).toEqual({
      cursor: String(NOW - 33 * DAY),
      updated_at: "2026-03-01T00:00:00.000Z",
    })
    expect(transactions(db)).toHaveLength(2)
  })

  it("stores nothing and sets no cursor when the first read fails", async () => {
    const db = ledger()
    const client = stubClient(() => {
      throw new SimpleFinError("network_error", "down")
    })
    await expect(
      syncSimpleFin({ db, client, assignments: ASSIGNMENTS, now: () => NOW_MS })
    ).rejects.toThrow("down")
    expect(cursor(db)).toBeUndefined()
    expect(db.prepare("SELECT COUNT(*) AS n FROM accounts").get()).toEqual({
      n: 0,
    })
  })

  it("rolls back a window whose write fails, leaving the cursor where it was", async () => {
    const db = ledger()
    db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON transactions
      WHEN NEW.id = 'acc_chk:tx_2' BEGIN SELECT RAISE(ABORT, 'refused'); END`)
    await expect(
      syncSimpleFin({
        db,
        client: stubClient(() => ACCOUNT_SET),
        assignments: ASSIGNMENTS,
        now: () => NOW_MS,
      })
    ).rejects.toThrow("refused")
    expect(cursor(db)).toBeUndefined()
    expect(transactions(db)).toEqual([])
    expect(db.prepare("SELECT COUNT(*) AS n FROM accounts").get()).toEqual({
      n: 0,
    })
  })
})

describe("healthMessages", () => {
  it("says how many accounts need an entity, then SimpleFIN's errors, within the schema's limits", () => {
    expect(healthMessages(1, [])).toEqual(["1 account needs an entity"])
    expect(healthMessages(0, ["  ", " Lorem "])).toEqual(["Lorem"])
    const many = healthMessages(
      3,
      Array.from({ length: 30 }, (_, i) => `e${String(i)}`)
    )
    expect(many).toHaveLength(20)
    expect(many[0]).toBe("3 accounts need an entity")
    expect(many[19]).toBe("e18")
    expect(healthMessages(0, ["x".repeat(600)])[0]).toHaveLength(500)
  })
})
