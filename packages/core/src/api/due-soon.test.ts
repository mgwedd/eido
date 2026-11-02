import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { insertObligation } from "../ledger/store"
import type { ObligationInput } from "../ledger/types"
import { addDocs, ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import { listDueSoon } from "./due-soon"

let db: DatabaseSync
let propertyId: string
let companyId: string
let docA: string
let docB: string

beforeEach(async () => {
  const fixture = await ledgerFixture()
  db = fixture.db
  propertyId = fixture.property.id
  companyId = fixture.company.id
  ;[docA = "", docB = ""] = addDocs(db, [
    testDoc("due-soon-a", { entityId: propertyId }),
    testDoc("due-soon-b", { entityId: companyId }),
  ])
})

function addObligation(
  over: Omit<Partial<ObligationInput>, "dueAt"> & { dueAt?: string | null } = {}
): Promise<number> {
  const { dueAt, ...fields } = over
  const defaultDueDate = Object.hasOwn(over, "dueAt")
    ? {}
    : { dueAt: "2026-06-01" }
  return insertObligation(db, {
    entityId: propertyId,
    action: "Pay the invoice",
    party: "Example Utility",
    status: "open",
    docId: docA,
    span: { start: 12, end: 28 },
    ...defaultDueDate,
    ...fields,
    ...(typeof dueAt === "string" ? { dueAt } : {}),
  })
}

describe("listDueSoon", () => {
  test("returns overdue through the inclusive 90th local calendar date with ledger provenance", async () => {
    const overdueId = await addObligation({ dueAt: "2026-03-01" })
    const todayId = await addObligation({
      dueAt: "2026-03-08",
      direction: "waiting",
    })
    const lastDayId = await addObligation({ dueAt: "2026-06-05" })
    await addObligation({ dueAt: "2026-06-06" })
    await addObligation({ dueAt: null })
    await addObligation({ status: "done" })
    await addObligation({ status: "dismissed" })
    const page = listDueSoon(db, {
      now: new Date("2026-03-08T16:00:00.000Z"),
      timezone: "America/New_York",
    })

    expect(page).toMatchObject({
      timezone: "America/New_York",
      fromDate: "2026-03-08",
      throughDate: "2026-06-05",
      entries: [
        {
          id: overdueId,
          dueAt: "2026-03-01",
          source: { documentId: docA, span: { start: 12, end: 28 } },
        },
        { id: todayId, dueAt: "2026-03-08", direction: "waiting" },
        { id: lastDayId, dueAt: "2026-06-05" },
      ],
    })
  })

  test("uses UTC explicitly before profile setup and follows a local day across DST", () => {
    const beforeBoundary = listDueSoon(db, {
      now: new Date("2026-03-08T04:30:00.000Z"),
      timezone: "America/New_York",
    })
    const afterBoundary = listDueSoon(db, {
      now: new Date("2026-03-08T07:30:00.000Z"),
      timezone: "America/New_York",
    })
    const fallback = listDueSoon(db, {
      now: new Date("2026-03-08T04:30:00.000Z"),
      timezone: null,
    })

    expect([beforeBoundary.fromDate, beforeBoundary.throughDate]).toEqual([
      "2026-03-07",
      "2026-06-04",
    ])
    expect([afterBoundary.fromDate, afterBoundary.throughDate]).toEqual([
      "2026-03-08",
      "2026-06-05",
    ])
    expect([
      fallback.timezone,
      fallback.fromDate,
      fallback.throughDate,
    ]).toEqual(["Etc/UTC", "2026-03-08", "2026-06-05"])
  })

  test("filters to one entity and keeps pages stable for equal due dates", async () => {
    const firstId = await addObligation({ dueAt: "2026-03-08" })
    const secondId = await addObligation({ dueAt: "2026-03-08" })
    await addObligation({
      entityId: companyId,
      docId: docB,
      dueAt: "2026-03-08",
    })
    const options = {
      now: new Date("2026-03-08T12:00:00.000Z"),
      timezone: "Etc/UTC",
      entityId: propertyId,
      limit: 1,
    }
    const first = listDueSoon(db, options)
    const second = listDueSoon(db, {
      ...options,
      offset: first.nextOffset ?? 0,
    })

    expect(first.entries.map((entry) => entry.id)).toEqual([firstId])
    expect(second.entries.map((entry) => entry.id)).toEqual([secondId])
    expect(first.nextOffset).toBe(1)
    expect(second.nextOffset).toBeNull()
  })

  test("returns no rows for an entity without matching obligations and rejects invalid offsets and limits", async () => {
    await addObligation()

    expect(
      listDueSoon(db, {
        now: new Date("2026-03-08T12:00:00.000Z"),
        timezone: "Etc/UTC",
        entityId: "missing-entity",
      }).entries
    ).toEqual([])
    expect(() => listDueSoon(db, { offset: -1 })).toThrow(
      "offset must be a nonnegative safe integer"
    )
    expect(() => listDueSoon(db, { limit: 201 })).toThrow(
      "limit must be between"
    )
  })

  test("rejects an invalid timezone rather than hiding corrupt profile configuration", () => {
    expect(() => listDueSoon(db, { timezone: "Mars/Olympus" })).toThrow(
      "timezone must be a valid IANA timezone"
    )
  })
})
