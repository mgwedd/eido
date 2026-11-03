import { describe, expect, it } from "vitest"
import { openIndex } from "../../index/schema"
import type { SimpleFinClient } from "./client"
import * as FacadeModule from "./facade"
import { createSimpleFinFacade } from "./facade"
import { simplefinManifest } from "./manifest"

describe("simplefin facade and manifest safety", () => {
  it("declares only effect: read operations in manifest", () => {
    const manifest = simplefinManifest()
    expect(manifest.operations.length).toBeGreaterThan(0)
    for (const op of manifest.operations) {
      expect(op.effect).toBe("read")
      expect(op.name).not.toMatch(/write|transfer|pay|send|delete|charge|debit/i)
    }
  })

  it("exports no verb or function that writes, transfers, pays or modifies funds", () => {
    const forbiddenPatterns = [
      /write/i,
      /transfer/i,
      /pay/i,
      /send/i,
      /delete/i,
      /charge/i,
      /debit/i,
      /credit/i,
      /execute/i,
      /post(?!ed)/i, // allow posted / postedAt, forbid post / postPayment
      /mutate/i,
      /update/i,
    ]

    for (const exportName of Object.keys(FacadeModule)) {
      for (const pattern of forbiddenPatterns) {
        expect(exportName).not.toMatch(pattern)
      }
    }

    const dummyClient: SimpleFinClient = {
      getAccounts: () => Promise.resolve({ accounts: [], errors: [] }),
    }
    const db = openIndex(":memory:")
    const facade = createSimpleFinFacade({ db, client: dummyClient })
    const methodNames = Object.keys(facade)

    for (const method of methodNames) {
      for (const pattern of forbiddenPatterns) {
        expect(method).not.toMatch(pattern)
      }
    }
  })

  it("lists accounts and transactions with filters", async () => {
    const db = openIndex(":memory:")
    db.prepare(`
      INSERT INTO entities (id, kind, name, tag, created_at)
      VALUES ('ent_1', 'personal', 'Personal', 'PERS', '2026-01-01T00:00:00Z')
    `).run()

    db.prepare(`
      INSERT INTO accounts (id, connector, name, currency, entity_id, balance_cents, balance_at)
      VALUES ('acc_1', 'simplefin', 'Main Checking', 'USD', 'ent_1', 500000, '2026-11-01T00:00:00Z')
    `).run()

    db.prepare(`
      INSERT INTO transactions (
        id, account_id, entity_id, posted_at, amount_cents, currency, description, category, raw_json, ingested_at
      )
      VALUES (
        'acc_1:tx_1', 'acc_1', 'ent_1', '2026-11-02T12:00:00Z', -1230, 'USD', 'Grocery Store', NULL, '{}', '2026-11-02T12:05:00Z'
      )
    `).run()

    const dummyClient: SimpleFinClient = {
      getAccounts: () => Promise.resolve({ accounts: [], errors: [] }),
    }

    const facade = createSimpleFinFacade({ db, client: dummyClient })

    const accounts = await facade.listAccounts()
    expect(accounts).toEqual([
      {
        id: "acc_1",
        connector: "simplefin",
        name: "Main Checking",
        currency: "USD",
        entityId: "ent_1",
        balanceCents: 500000,
        balanceAt: "2026-11-01T00:00:00Z",
      },
    ])

    const txs = await facade.listTransactions()
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({
      id: "acc_1:tx_1",
      accountId: "acc_1",
      entityId: "ent_1",
      postedAt: "2026-11-02T12:00:00Z",
      amountCents: -1230,
      currency: "USD",
      description: "Grocery Store",
    })

    const filtered = await facade.listTransactions({ accountId: "acc_other" })
    expect(filtered).toHaveLength(0)
  })
})
