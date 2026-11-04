import { describe, expect, it, vi } from "vitest"
import type { DatabaseSync } from "node:sqlite"
import { openIndex } from "../../index/schema"
import { insertExtraction, insertObligation, linksFor } from "../../ledger"
import {
  addDocs,
  ledgerFixture,
  testDoc,
} from "../../ledger/ledger.test-support"
import { parseAccountSet, SimpleFinError } from "./client"
import type { GetAccountsParams, SimpleFinClient } from "./client"
import { assignSimpleFinAccount, listSimpleFinAccounts } from "./accounts"
import {
  backfillSimpleFin,
  CURSOR_OVERLAP_SECONDS,
  healthMessages,
  syncSimpleFin,
} from "./sync"

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

/** The owner's assignment, as Settings stores it: on the account row, before the sync reads it. */
function assign(db: DatabaseSync, entities: Record<string, string>): void {
  const insert = db.prepare(
    "INSERT INTO accounts (id, connector, name, currency, entity_id) VALUES (?, 'simplefin', 'Seeded', 'USD', ?)"
  )
  for (const [account, entity] of Object.entries(entities))
    insert.run(account, entity)
}

function assigned(): DatabaseSync {
  const db = ledger()
  assign(db, { acc_chk: "ent_home" })
  return db
}

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
  it("links a stored debit to the obligation it paid", async () => {
    const { db, property } = await ledgerFixture()
    const [docId = ""] = addDocs(db, [
      testDoc("bill", { entityId: property.id }),
    ])
    await insertExtraction(db, {
      docId,
      schema: "extracted-fields",
      status: "extracted",
      fields: {
        action: { raw: "Lorem", span: { start: 0, end: 5 } },
        amount: {
          raw: "USD 12.30",
          span: { start: 0, end: 9 },
          status: "parsed",
          value: { amount_minor: 1230, currency: "USD" },
        },
      },
      confidence: { action: 0.9, amount: 0.9 },
      model: "local-test-model",
      createdAt: "2026-02-01T00:00:00.000Z",
    })
    const id = await insertObligation(db, {
      entityId: property.id,
      action: "Pay the cafe invoice",
      dueAt: "2026-02-25",
      status: "open",
      docId,
      span: { start: 0, end: 9 },
    })
    assign(db, { acc_chk: property.id })
    const result = await syncSimpleFin({
      db,
      client: stubClient(() => ACCOUNT_SET),
      now: () => NOW_MS,
    })
    expect(result.paymentsLinked).toBe(1)
    // tx_1 is the -12.30 debit; the 0.07 credit pays nothing.
    expect(linksFor(db, `obl:${id}`).map((link) => link.src)).toEqual([
      "txn:acc_chk:tx_1",
    ])
  })

  it("tags every stored transaction with its account's entity and stores amounts as integer cents", async () => {
    const db = assigned()
    const result = await syncSimpleFin({
      db,
      client: stubClient(() => ACCOUNT_SET),
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
      // The index alone, with no ledger: there are no obligations to link.
      paymentsLinked: 0,
      // Two accounts with no entity: acc_sav and acc_biz.
      unassignedAccounts: 2,
      // 12.345 is malformed; tx_6 has no description.
      rejectedTransactions: 2,
      cursor: NOW,
      errors: ["Bridge note: see [url]"],
      messages: ["2 accounts need an entity", "Bridge note: see [url]"],
    })
  })

  it("keeps the owner's entity, stores new accounts with none, and stores none of their transactions", async () => {
    const db = assigned()
    await syncSimpleFin({
      db,
      client: stubClient(() => ACCOUNT_SET),
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
    const db = assigned()
    const client = stubClient(() => ACCOUNT_SET)
    const options = { db, client }
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
    const db = assigned()
    db.prepare(
      "INSERT INTO cursors (connector, stream, cursor, updated_at) VALUES ('simplefin', 'transactions', ?, 'x')"
    ).run(String(NOW - 120 * DAY))
    const client = stubClient((_params, call) => {
      if (call === 2) throw new SimpleFinError("daily_limit", "spent")
      return ACCOUNT_SET
    })
    await expect(
      syncSimpleFin({ db, client, now: () => NOW_MS })
    ).rejects.toThrow("spent")
    expect(cursor(db)).toEqual({
      cursor: String(NOW - 33 * DAY),
      updated_at: "2026-03-01T00:00:00.000Z",
    })
    expect(transactions(db)).toHaveLength(2)
  })

  it("stores nothing and sets no cursor when the first read fails", async () => {
    const db = assigned()
    const client = stubClient(() => {
      throw new SimpleFinError("network_error", "down")
    })
    await expect(
      syncSimpleFin({ db, client, now: () => NOW_MS })
    ).rejects.toThrow("down")
    expect(cursor(db)).toBeUndefined()
    expect(db.prepare("SELECT id, name FROM accounts").all()).toEqual([
      { id: "acc_chk", name: "Seeded" },
    ])
  })

  it("rolls back a window whose write fails, leaving the cursor where it was", async () => {
    const db = assigned()
    db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON transactions
      WHEN NEW.id = 'acc_chk:tx_2' BEGIN SELECT RAISE(ABORT, 'refused'); END`)
    await expect(
      syncSimpleFin({
        db,
        client: stubClient(() => ACCOUNT_SET),
        now: () => NOW_MS,
      })
    ).rejects.toThrow("refused")
    expect(cursor(db)).toBeUndefined()
    expect(transactions(db)).toEqual([])
    expect(db.prepare("SELECT id, name FROM accounts").all()).toEqual([
      { id: "acc_chk", name: "Seeded" },
    ])
  })
})

/** Answers like SimpleFIN: only transactions posted inside the window, only the accounts asked for. */
function windowedClient(): SimpleFinClient & { calls: GetAccountsParams[] } {
  return stubClient((params) => ({
    ...ACCOUNT_SET,
    accounts: ACCOUNT_SET.accounts
      .filter(
        (account) =>
          params.accounts === undefined || params.accounts.includes(account.id)
      )
      .map((account) => ({
        ...account,
        transactions: account.transactions.filter(
          (transaction) =>
            transaction.posted >= (params.startDate ?? 0) &&
            transaction.posted < (params.endDate ?? Infinity)
        ),
      })),
  }))
}

const LATER_MS = NOW_MS + 30 * DAY * 1000
const LATER = LATER_MS / 1000

describe("an account assigned in Settings", () => {
  it("has its transactions stored under that entity by the next sync, and the health count drops", async () => {
    const db = assigned()
    const client = stubClient(() => ACCOUNT_SET)
    const first = await syncSimpleFin({ db, client, now: () => NOW_MS })
    expect(first.messages[0]).toBe("2 accounts need an entity")

    await assignSimpleFinAccount(db, "acc_sav", "ent_shop")
    const next = await syncSimpleFin({ db, client, now: () => NOW_MS + 60_000 })
    expect(next.messages[0]).toBe("1 account needs an entity")
    expect(next.unassignedAccounts).toBe(1)
    expect(
      db
        .prepare(
          "SELECT id, entity_id FROM transactions WHERE account_id = 'acc_sav'"
        )
        .all()
    ).toEqual([{ id: "acc_sav:tx_9", entity_id: "ent_shop" }])
  })

  it("gets the older transactions the sync skipped backfilled, without moving the cursor", async () => {
    const db = assigned()
    const client = windowedClient()
    await syncSimpleFin({ db, client, now: () => NOW_MS })
    await assignSimpleFinAccount(db, "acc_sav", "ent_home")
    // A month on, the sync reads from the cursor less the overlap: tx_9 is older than that.
    await syncSimpleFin({ db, client, now: () => LATER_MS })
    expect(transactions(db).map((row) => row["id"])).toEqual([
      "acc_chk:tx_1",
      "acc_chk:tx_2",
    ])
    client.calls.length = 0

    const result = await backfillSimpleFin({ db, client, now: () => LATER_MS })
    expect(client.calls).toEqual([
      { startDate: LATER - 90 * DAY, endDate: LATER, accounts: ["acc_sav"] },
    ])
    expect(result).toEqual({
      accounts: 1,
      transactionsStored: 1,
      rejectedTransactions: 0,
      paymentsLinked: 0,
    })
    expect(
      db
        .prepare(
          "SELECT id, entity_id, amount_cents FROM transactions WHERE account_id = 'acc_sav'"
        )
        .all()
    ).toEqual([
      { id: "acc_sav:tx_9", entity_id: "ent_home", amount_cents: 10000 },
    ])
    expect(listSimpleFinAccounts(db).map((a) => a.backfillPending)).toEqual([
      false,
      false,
      false,
    ])
    expect(cursor(db)?.["cursor"]).toBe(String(LATER))
  })

  it("makes no request when no account waits for a backfill", async () => {
    const db = assigned()
    const client = windowedClient()
    expect(await backfillSimpleFin({ db, client, now: () => NOW_MS })).toEqual({
      accounts: 0,
      transactionsStored: 0,
      rejectedTransactions: 0,
      paymentsLinked: 0,
    })
    expect(client.calls).toEqual([])
  })

  it("stores only the accounts it asked for, and lets go of one SimpleFIN no longer returns", async () => {
    const db = ledger()
    assign(db, { acc_gone: "ent_home" })
    db.exec("UPDATE accounts SET backfill_pending = 1")
    // SimpleFIN ignores the filter here and returns every account, none of them acc_gone.
    const client = stubClient(() => ACCOUNT_SET)
    const result = await backfillSimpleFin({
      db,
      client,
      config: { maxDateRangeDays: 30 },
      now: () => NOW_MS,
    })
    expect(client.calls[0]?.startDate).toBe(NOW - 30 * DAY)
    expect(result.transactionsStored).toBe(0)
    expect(
      db.prepare("SELECT id, backfill_pending FROM accounts").all()
    ).toEqual([{ id: "acc_gone", backfill_pending: 0 }])
  })

  it("keeps the account waiting when the backfill write fails", async () => {
    const db = assigned()
    await syncSimpleFin({ db, client: windowedClient(), now: () => NOW_MS })
    await assignSimpleFinAccount(db, "acc_biz", "ent_shop")
    db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON transactions
      WHEN NEW.account_id = 'acc_biz' BEGIN SELECT RAISE(ABORT, 'refused'); END`)
    await expect(
      backfillSimpleFin({ db, client: windowedClient(), now: () => NOW_MS })
    ).rejects.toThrow("refused")
    expect(
      db
        .prepare("SELECT backfill_pending FROM accounts WHERE id = 'acc_biz'")
        .get()
    ).toEqual({ backfill_pending: 1 })
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
