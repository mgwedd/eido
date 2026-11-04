import { validateCoreApiSimpleFinAccountList } from "@eido/schemas"
import { describe, expect, test, vi } from "vitest"
import { pendingBackfillAccounts } from "../connectors/simplefin/accounts"
import { openIndex } from "../index/schema"
import { createProfileStore } from "../profile/index"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"

// Synthetic accounts and entities only.

const HOME = "00000000-0000-4000-8000-000000000001"
const SHOP = "00000000-0000-4000-8000-000000000002"

function setup(configured = true) {
  const db = openIndex(":memory:")
  db.exec(`
    INSERT INTO entities (id, kind, name, tag, created_at) VALUES
      ('${HOME}', 'personal', 'Home', 'HOME', '2026-01-01T00:00:00Z'),
      ('${SHOP}', 'company', 'Shop Co', 'SHOP', '2026-01-01T00:00:00Z');
    INSERT INTO accounts (id, connector, name, currency, entity_id, balance_cents, balance_at) VALUES
      ('acc_a', 'simplefin', 'Everyday', 'USD', '${HOME}', -1250, '2026-02-20T12:00:00.000Z'),
      ('acc_b', 'simplefin', 'Rainy day', 'USD', NULL, 5000, NULL);`)
  const backfill = vi.fn(() => Promise.resolve())
  const profile = createProfileStore(db, { audit: () => Promise.resolve() })
  const handle: ApiHandler = createApiHandler({
    profile,
    allowedHosts: ["core.test"],
    ...(configured ? { simplefinAccounts: { db, backfill } } : {}),
  })
  return { db, handle, backfill }
}

const list = (handle: ApiHandler, method = "GET"): Promise<Response> =>
  handle(
    new Request("http://core.test/connectors/simplefin/accounts", { method })
  )

const assign = (
  handle: ApiHandler,
  body: unknown,
  method = "PUT"
): Promise<Response> =>
  handle(
    new Request("http://core.test/connectors/simplefin/assignments", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )

describe("GET /connectors/simplefin/accounts", () => {
  test("lists the stored accounts with their entity and balance", async () => {
    const { handle } = setup()
    const response = await list(handle)
    const body: unknown = await response.json()
    expect(response.status).toBe(200)
    expect(body).toEqual({
      accounts: [
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
      ],
    })
    expect(validateCoreApiSimpleFinAccountList(body).ok).toBe(true)
  })

  test("only GET is allowed", async () => {
    const { handle } = setup()
    expect((await list(handle, "POST")).status).toBe(405)
  })
})

describe("PUT /connectors/simplefin/assignments", () => {
  test("stores the entity of an unassigned account and starts its backfill", async () => {
    const { handle, backfill, db } = setup()
    const response = await assign(handle, {
      accountId: "acc_b",
      entityId: SHOP,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      id: "acc_b",
      name: "Rainy day",
      currency: "USD",
      balanceCents: 5000,
      balanceAt: null,
      entityId: SHOP,
      backfillPending: true,
    })
    expect(backfill).toHaveBeenCalledTimes(1)
    expect(pendingBackfillAccounts(db)).toEqual(["acc_b"])
  })

  test("a change of entity starts no backfill", async () => {
    const { handle, backfill } = setup()
    const response = await assign(handle, {
      accountId: "acc_a",
      entityId: SHOP,
    })
    expect(response.status).toBe(200)
    expect(backfill).not.toHaveBeenCalled()
  })

  test("a body that fails the schema answers 422 with its fields", async () => {
    const { handle, backfill } = setup()
    const response = await assign(handle, { accountId: "acc_b" })
    expect([response.status, await response.json()]).toEqual([
      422,
      {
        error: {
          code: "invalid",
          message: "invalid input",
          fields: [{ field: "entityId", message: "required" }],
        },
      },
    ])
    expect(backfill).not.toHaveBeenCalled()
  })

  test("an unknown account answers 404", async () => {
    const { handle } = setup()
    const response = await assign(handle, {
      accountId: "acc_x",
      entityId: SHOP,
    })
    expect([response.status, await response.json()]).toEqual([
      404,
      { error: { code: "not_found", message: "no such account" } },
    ])
  })

  test("an unknown entity answers 422 on the entityId field", async () => {
    const { handle } = setup()
    const response = await assign(handle, {
      accountId: "acc_b",
      entityId: "00000000-0000-4000-8000-0000000000ff",
    })
    expect([response.status, await response.json()]).toEqual([
      422,
      {
        error: {
          code: "invalid",
          message: "invalid input",
          fields: [{ field: "entityId", message: "no such entity" }],
        },
      },
    ])
  })

  test("only PUT is allowed", async () => {
    const { handle } = setup()
    expect((await assign(handle, {}, "POST")).status).toBe(405)
  })
})

test("neither route is served when core has no SimpleFIN plane", async () => {
  const { handle } = setup(false)
  expect((await list(handle)).status).toBe(404)
  expect(
    (await assign(handle, { accountId: "acc_b", entityId: SHOP })).status
  ).toBe(404)
})
