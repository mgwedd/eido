import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { LedgerError } from "./errors"
import { addDocs, ledgerFixture, testDoc } from "./ledger.test-support"
import {
  MAX_OBLIGATION_CALLS,
  createObligationStateStore,
} from "./obligation-state"
import type {
  ObligationAuditEntry,
  ObligationAuditSink,
  ObligationStateStore,
} from "./obligation-state"
import { insertObligation, listObligations } from "./store"
import type { ObligationStatus } from "./types"

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

let db: DatabaseSync
let audits: ObligationAuditEntry[]
let store: ObligationStateStore
let openId: number
let entityId: string
let docs = 0

function addObligation(status: ObligationStatus = "open"): number {
  const [docId = ""] = addDocs(db, [
    testDoc(`doc-${String(++docs)}`, { entityId }),
  ])
  return insertObligation(db, {
    entityId,
    party: "Example Utility",
    action: "Pay the invoice",
    dueAt: "2030-02-01",
    status,
    docId,
    span: { start: 0, end: 4 },
  })
}

const statusOf = (id: number): ObligationStatus | undefined =>
  listObligations(db).find((o) => o.id === id)?.status

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof LedgerError) return error.code
    throw error
  }
  return "none"
}

function storeWith(audit: ObligationAuditSink): ObligationStateStore {
  return createObligationStateStore(db, { audit })
}

beforeEach(async () => {
  const fixture = await ledgerFixture()
  db = fixture.db
  entityId = fixture.property.id
  audits = []
  store = storeWith((entry) => {
    audits.push(entry)
    return Promise.resolve()
  })
  openId = addObligation()
})

describe("obligation state changes", () => {
  test.each(["done", "resolve"] as const)(
    "%s moves an open obligation to done and audits it with hashes only",
    async (change) => {
      expect(await store.change(openId, change)).toEqual({
        id: openId,
        status: "done",
      })
      expect(statusOf(openId)).toBe("done")
      expect(audits).toEqual([
        {
          action: `obligation.${change}`,
          subjectHash: hash(`obl:${String(openId)}`),
          beforeHash: hash({ id: openId, status: "open" }),
          afterHash: hash({ id: openId, status: "done" }),
        },
      ])
      expect(JSON.stringify(audits)).not.toContain("Pay the invoice")
    }
  )

  test("reopen restores the state an obligation was marked from", async () => {
    await store.change(openId, "done")
    expect(await store.change(openId, "reopen")).toEqual({
      id: openId,
      status: "open",
    })
    expect(statusOf(openId)).toBe("open")
    expect(audits.map((a) => a.action)).toEqual([
      "obligation.done",
      "obligation.reopen",
    ])
    expect(audits[1]).toMatchObject({
      beforeHash: hash({ id: openId, status: "done" }),
      afterHash: hash({ id: openId, status: "open" }),
    })
  })

  test("leaves every other column as it was", async () => {
    const before = listObligations(db)
    await store.change(openId, "resolve")
    await store.change(openId, "reopen")
    expect(listObligations(db)).toEqual(before)
  })

  test.each([
    ["done", "done"],
    ["resolve", "done"],
    ["done", "dismissed"],
    ["resolve", "dismissed"],
    ["reopen", "open"],
    ["reopen", "dismissed"],
  ] as const)(
    "refuses %s on a %s obligation without auditing or changing it",
    async (change, status) => {
      const id = addObligation(status)
      expect(await codeOf(store.change(id, change))).toBe("invalid_transition")
      expect(statusOf(id)).toBe(status)
      expect(audits).toEqual([])
    }
  )

  test("refuses an unknown obligation", async () => {
    expect(await codeOf(store.change(openId + 1000, "done"))).toBe(
      "obligation_not_found"
    )
    expect(audits).toEqual([])
  })

  test("rolls the change back when the audit sink rejects", async () => {
    const failing = storeWith(() => Promise.reject(new Error("gate down")))
    await expect(failing.change(openId, "done")).rejects.toThrow("gate down")
    expect(statusOf(openId)).toBe("open")
    expect(db.isTransaction).toBe(false)
  })

  test("runs calls one at a time, so a second change sees the first", async () => {
    let release: () => void = () => {}
    const gated = storeWith(
      (entry) =>
        new Promise<void>((resolve) => {
          audits.push(entry)
          release = resolve
        })
    )
    const first = gated.change(openId, "done")
    const second = gated.change(openId, "done")
    await Promise.resolve()
    await Promise.resolve()
    release()
    expect(await first).toEqual({ id: openId, status: "done" })
    expect(await codeOf(second)).toBe("invalid_transition")
    expect(audits).toHaveLength(1)
    await gated.drain()
  })

  test("refuses calls beyond the queue limit with busy", async () => {
    let release: (() => void) | undefined
    const gated = storeWith(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const calls = Array.from({ length: MAX_OBLIGATION_CALLS }, () =>
      codeOf(gated.change(openId, "done"))
    )
    expect(await codeOf(gated.change(openId, "done"))).toBe("busy")
    while (release === undefined) await new Promise((r) => setImmediate(r))
    release()
    const codes = await Promise.all(calls)
    expect(codes.filter((code) => code === "none")).toHaveLength(1)
    expect(codes.filter((code) => code === "invalid_transition")).toHaveLength(
      MAX_OBLIGATION_CALLS - 1
    )
    await gated.drain()
    expect(statusOf(openId)).toBe("done")
  })
})
