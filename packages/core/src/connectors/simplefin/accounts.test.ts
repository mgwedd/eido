import { describe, expect, it } from "vitest"
import type { DatabaseSync } from "node:sqlite"
import { openIndex } from "../../index/schema"
import {
  assignSimpleFinAccount,
  countUnassignedAccounts,
  listSimpleFinAccounts,
  pendingBackfillAccounts,
} from "./accounts"

// Synthetic accounts and entities only.

const HOME = "00000000-0000-4000-8000-000000000001"
const SHOP = "00000000-0000-4000-8000-000000000002"

function store(): DatabaseSync {
  const db = openIndex(":memory:")
  db.exec(`
    INSERT INTO entities (id, kind, name, tag, created_at) VALUES
      ('${HOME}', 'personal', 'Home', 'HOME', '2026-01-01T00:00:00Z'),
      ('${SHOP}', 'company', 'Shop Co', 'SHOP', '2026-01-01T00:00:00Z');
    INSERT INTO accounts (id, connector, name, currency, entity_id, balance_cents, balance_at) VALUES
      ('acc_b', 'simplefin', 'Rainy day', 'USD', NULL, 5000, NULL),
      ('acc_a', 'simplefin', 'Everyday', 'USD', '${HOME}', -1250, '2026-02-20T12:00:00.000Z'),
      ('acc_m', 'other', 'Not SimpleFIN', 'USD', NULL, NULL, NULL);
    INSERT INTO transactions (id, account_id, entity_id, posted_at, amount_cents, currency, description, raw_json, ingested_at) VALUES
      ('acc_a:t1', 'acc_a', '${HOME}', '2026-02-20T12:00:00.000Z', -100, 'USD', 'Lorem', '{}', '2026-02-21T00:00:00.000Z');`)
  return db
}

function entitiesOf(db: DatabaseSync, account: string): unknown[] {
  return db
    .prepare("SELECT entity_id FROM transactions WHERE account_id = ?")
    .all(account)
    .map((row) => row["entity_id"])
}

describe("listSimpleFinAccounts", () => {
  it("lists only SimpleFIN accounts, by name, with their entity, balance and backfill state", () => {
    expect(listSimpleFinAccounts(store())).toEqual([
      {
        id: "acc_a",
        name: "Everyday",
        currency: "USD",
        balanceCents: -1250,
        balanceAt: "2026-02-20T12:00:00.000Z",
        entityId: HOME,
        backfillPending: false,
      },
      {
        id: "acc_b",
        name: "Rainy day",
        currency: "USD",
        balanceCents: 5000,
        balanceAt: null,
        entityId: null,
        backfillPending: false,
      },
    ])
  })
})

describe("countUnassignedAccounts", () => {
  it("counts SimpleFIN accounts with no entity", () => {
    const db = store()
    expect(countUnassignedAccounts(db)).toBe(1)
    db.exec(`UPDATE accounts SET entity_id = '${SHOP}' WHERE id = 'acc_b'`)
    expect(countUnassignedAccounts(db)).toBe(0)
  })
})

describe("assignSimpleFinAccount", () => {
  it("marks a first assignment for a backfill", async () => {
    const db = store()
    const result = await assignSimpleFinAccount(db, "acc_b", SHOP)
    expect(result).toEqual({
      status: "assigned",
      account: {
        id: "acc_b",
        name: "Rainy day",
        currency: "USD",
        balanceCents: 5000,
        balanceAt: null,
        entityId: SHOP,
        backfillPending: true,
      },
    })
    expect(pendingBackfillAccounts(db)).toEqual(["acc_b"])
    expect(countUnassignedAccounts(db)).toBe(0)
  })

  it("moves the stored transactions of an account changed to another entity, with no backfill", async () => {
    const db = store()
    const result = await assignSimpleFinAccount(db, "acc_a", SHOP)
    expect(result.status === "assigned" && result.account.backfillPending).toBe(
      false
    )
    expect(entitiesOf(db, "acc_a")).toEqual([SHOP])
    expect(pendingBackfillAccounts(db)).toEqual([])
  })

  it("keeps a waiting backfill when the entity changes again before it runs", async () => {
    const db = store()
    await assignSimpleFinAccount(db, "acc_b", SHOP)
    await assignSimpleFinAccount(db, "acc_b", HOME)
    expect(pendingBackfillAccounts(db)).toEqual(["acc_b"])
    expect(listSimpleFinAccounts(db)[1]?.entityId).toBe(HOME)
  })

  it("changes nothing when the entity is the one already assigned", async () => {
    const db = store()
    db.exec(`CREATE TRIGGER refuse BEFORE UPDATE ON accounts
      BEGIN SELECT RAISE(ABORT, 'refused'); END`)
    const result = await assignSimpleFinAccount(db, "acc_a", HOME)
    expect(result.status === "assigned" && result.account.entityId).toBe(HOME)
  })

  it("refuses an account that is not a stored SimpleFIN account", async () => {
    const db = store()
    expect(await assignSimpleFinAccount(db, "acc_x", HOME)).toEqual({
      status: "unknown_account",
    })
    expect(await assignSimpleFinAccount(db, "acc_m", HOME)).toEqual({
      status: "unknown_account",
    })
  })

  it("refuses an entity that does not exist", async () => {
    const db = store()
    expect(
      await assignSimpleFinAccount(
        db,
        "acc_b",
        "00000000-0000-4000-8000-0000000000ff"
      )
    ).toEqual({ status: "unknown_entity" })
    expect(countUnassignedAccounts(db)).toBe(1)
  })

  it("leaves the account and its transactions as they were when the write fails", async () => {
    const db = store()
    db.exec(`CREATE TRIGGER refuse BEFORE UPDATE ON transactions
      BEGIN SELECT RAISE(ABORT, 'refused'); END`)
    await expect(assignSimpleFinAccount(db, "acc_a", SHOP)).rejects.toThrow(
      "refused"
    )
    expect(listSimpleFinAccounts(db)[0]?.entityId).toBe(HOME)
    expect(entitiesOf(db, "acc_a")).toEqual([HOME])
  })
})
