import type { DatabaseSync } from "node:sqlite"
import type { CoreApiError, CoreApiTodayDueSoon } from "@eido/schemas"
import { validateCoreApiTodayDueSoon } from "@eido/schemas"
import { beforeEach, describe, expect, test } from "vitest"
import { insertObligation } from "../ledger/store"
import { addDocs, ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import type { ProfileStore } from "../profile/store"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"

let db: DatabaseSync
let profile: ProfileStore
let propertyId: string
let companyId: string
let handle: ApiHandler

const NOW = new Date("2026-03-08T12:00:00.000Z")

beforeEach(async () => {
  const fixture = await ledgerFixture()
  db = fixture.db
  profile = fixture.profile
  propertyId = fixture.property.id
  companyId = fixture.company.id
  const [docA = "", docB = ""] = addDocs(db, [
    testDoc("route-a", { entityId: propertyId }),
    testDoc("route-b", { entityId: companyId }),
  ])
  const add = (
    entityId: string,
    docId: string,
    dueAt: string
  ): Promise<number> =>
    insertObligation(db, {
      entityId,
      action: "Pay the invoice",
      party: "Example Utility",
      status: "open",
      docId,
      span: { start: 12, end: 28 },
      dueAt,
    })
  await add(propertyId, docA, "2026-03-01")
  await add(propertyId, docA, "2026-03-09")
  await add(companyId, docB, "2026-03-20")
  handle = createApiHandler({
    profile,
    allowedHosts: ["core.test"],
    basePath: "/api/core",
    documents: { db },
    now: () => NOW,
  })
})

const get = (query = "", init?: RequestInit): Promise<Response> =>
  handle(new Request(`http://core.test/api/core/today/due-soon${query}`, init))

async function page(query = ""): Promise<CoreApiTodayDueSoon> {
  const response = await get(query)
  expect(response.status).toBe(200)
  const checked = validateCoreApiTodayDueSoon(await response.json())
  if (!checked.ok) throw new Error(checked.errors.join("; "))
  return checked.value
}

async function errorOf(
  response: Response
): Promise<CoreApiError["error"] & { status: number }> {
  const body = (await response.json()) as CoreApiError
  return { status: response.status, ...body.error }
}

describe("GET /today/due-soon", () => {
  test("uses UTC when the owner has no profile yet", async () => {
    const body = await page()
    expect(body).toMatchObject({
      timezone: "Etc/UTC",
      fromDate: "2026-03-08",
      throughDate: "2026-06-05",
      nextOffset: null,
    })
    expect(body.entries.map((e) => e.dueAt)).toEqual([
      "2026-03-01",
      "2026-03-09",
      "2026-03-20",
    ])
  })

  test("counts today in the profile timezone", async () => {
    await profile.updateProfile({
      displayName: "Example Owner",
      timezone: "Pacific/Auckland",
    })
    const body = await page()
    expect(body.timezone).toBe("Pacific/Auckland")
    expect(body.fromDate).toBe("2026-03-09")
    expect(body.throughDate).toBe("2026-06-06")
  })

  test("filters by entity and pages with limit and offset", async () => {
    const property = await page(`?entity=${propertyId}`)
    expect(property.entries.map((e) => e.entity.id)).toEqual([
      propertyId,
      propertyId,
    ])
    const first = await page("?limit=2")
    expect(first.entries.map((e) => e.dueAt)).toEqual([
      "2026-03-01",
      "2026-03-09",
    ])
    expect(first.nextOffset).toBe(2)
    const second = await page("?limit=2&offset=2")
    expect(second.entries.map((e) => e.dueAt)).toEqual(["2026-03-20"])
    expect(second.nextOffset).toBeNull()
  })

  test("rejects a limit or offset outside its range with 422", async () => {
    const error = await errorOf(await get("?limit=0&offset=x"))
    expect(error.status).toBe(422)
    expect(error.code).toBe("invalid")
    expect(error.fields?.map((f) => f.field)).toEqual(["limit", "offset"])
    expect((await errorOf(await get("?limit=201"))).status).toBe(422)
  })

  test("answers only GET", async () => {
    const response = await get("", { method: "POST" })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
  })

  test("is served only under the base path, for an allowed host, with the data DB", async () => {
    const outside = await handle(new Request("http://core.test/today/due-soon"))
    expect(outside.status).toBe(404)
    const misdirected = await handle(
      new Request("http://other.test/api/core/today/due-soon")
    )
    expect(misdirected.status).toBe(421)
    const noDocuments = createApiHandler({
      profile,
      allowedHosts: ["core.test"],
    })
    const absent = await noDocuments(
      new Request("http://core.test/today/due-soon")
    )
    expect(absent.status).toBe(404)
  })
})
