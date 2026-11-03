import type { DatabaseSync } from "node:sqlite"
import { GateUnavailableError } from "@eido/gate"
import type { CoreApiError, CoreApiObligationList } from "@eido/schemas"
import { validateCoreApiObligationList } from "@eido/schemas"
import { beforeEach, describe, expect, test } from "vitest"
import { addDocs, ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import {
  MAX_OBLIGATION_CALLS,
  createObligationStateStore,
} from "../ledger/obligation-state"
import type {
  ObligationAuditEntry,
  ObligationAuditSink,
} from "../ledger/obligation-state"
import { insertObligation, listObligations } from "../ledger/store"
import type { ProfileStore } from "../profile/store"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"

let fixture: Awaited<ReturnType<typeof ledgerFixture>>
let db: DatabaseSync
let profile: ProfileStore
let audits: ObligationAuditEntry[]
let handle: ApiHandler
let id: number

function handlerWith(audit: ObligationAuditSink): ApiHandler {
  return createApiHandler({
    profile,
    allowedHosts: ["core.test"],
    obligations: createObligationStateStore(db, { audit }),
  })
}

beforeEach(async () => {
  fixture = await ledgerFixture()
  db = fixture.db
  profile = fixture.profile
  const [docId = ""] = addDocs(db, [
    testDoc("a", { entityId: fixture.property.id }),
  ])
  id = await insertObligation(db, {
    entityId: fixture.property.id,
    action: "Pay the invoice",
    status: "open",
    docId,
    span: { start: 0, end: 4 },
  })
  audits = []
  handle = handlerWith((entry) => {
    audits.push(entry)
    return Promise.resolve()
  })
})

function post(
  path: string,
  body: string | undefined = "{}",
  h: ApiHandler = handle,
  headers: Record<string, string> = { "content-type": "application/json" }
): Promise<Response> {
  return h(
    new Request(`http://core.test${path}`, { method: "POST", headers, body })
  )
}

const statusOf = (): string | undefined =>
  listObligations(db).find((o) => o.id === id)?.status

describe("POST /obligations/:id/{done,resolve,reopen}", () => {
  test.each(["done", "resolve"])(
    "%s marks an open obligation done and audits it",
    async (change) => {
      const response = await post(`/obligations/${String(id)}/${change}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ id, status: "done" })
      expect(statusOf()).toBe("done")
      expect(audits.map((a) => a.action)).toEqual([`obligation.${change}`])
    }
  )

  test("reopen restores the open state, and a trailing slash is the same route", async () => {
    await post(`/obligations/${String(id)}/done`)
    const response = await post(`/obligations/${String(id)}/reopen/`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id, status: "open" })
    expect(statusOf()).toBe("open")
    expect(audits.map((a) => a.action)).toEqual([
      "obligation.done",
      "obligation.reopen",
    ])
  })

  test("answers 409 invalid_transition for a change that does not apply", async () => {
    const response = await post(`/obligations/${String(id)}/reopen`)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: { code: "invalid_transition", message: "obligation is not done" },
    })
    expect(audits).toEqual([])
  })

  test.each([
    ["an unknown id", "/obligations/999/done"],
    ["a zero id", "/obligations/0/done"],
    ["a non-numeric id", "/obligations/abc/done"],
    ["an id with a leading zero", `/obligations/0${String(id)}/done`],
    ["an unsafe integer id", "/obligations/9999999999999999/done"],
  ])("answers 404 for %s", async (_, path) => {
    const response = await post(path)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: "not_found" },
    })
    expect(statusOf()).toBe("open")
  })

  test("answers 404 for an unknown change", async () => {
    expect((await post(`/obligations/${String(id)}/archive`)).status).toBe(404)
  })

  test.each([
    ["a non-empty object", '{"status":"done"}'],
    ["an array", "[]"],
    ["null", "null"],
  ])("answers 422 for %s as the body", async (_, body) => {
    const response = await post(`/obligations/${String(id)}/done`, body)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: {
        code: "invalid",
        message: "invalid input",
        fields: [{ field: "", message: "must be an empty object" }],
      },
    })
    expect(statusOf()).toBe("open")
  })

  test("requires the JSON content type, which keeps cross-site forms out", async () => {
    const response = await post(`/obligations/${String(id)}/done`, "", handle, {
      "content-type": "application/x-www-form-urlencoded",
    })
    expect(response.status).toBe(415)
    expect(statusOf()).toBe("open")
  })

  test("answers 405 with Allow for other methods", async () => {
    const response = await handle(
      new Request(`http://core.test/obligations/${String(id)}/done`)
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
  })

  test("answers 503 and keeps the obligation open when the gate is unavailable", async () => {
    const h = handlerWith(() =>
      Promise.reject(new GateUnavailableError("gate down"))
    )
    const response = await post(`/obligations/${String(id)}/done`, "{}", h)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { code: "gate_unavailable" },
    })
    expect(statusOf()).toBe("open")
  })

  test("answers 503 busy when too many changes are waiting", async () => {
    let release: (() => void) | undefined
    const h = handlerWith(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const waiting = Array.from({ length: MAX_OBLIGATION_CALLS }, () =>
      post(`/obligations/${String(id)}/done`, "{}", h)
    )
    const response = await post(`/obligations/${String(id)}/done`, "{}", h)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "busy" } })
    while (release === undefined) await new Promise((r) => setImmediate(r))
    release()
    await Promise.all(waiting)
  })

  test("is not served without an obligation store", async () => {
    const h = createApiHandler({ profile, allowedHosts: ["core.test"] })
    expect(
      (await post(`/obligations/${String(id)}/done`, "{}", h)).status
    ).toBe(404)
  })
})

describe("GET /obligations", () => {
  let listHandle: ApiHandler
  let propertyId: string
  let companyId: string
  let docA: string
  let docB: string

  beforeEach(() => {
    propertyId = fixture.property.id
    companyId = fixture.company.id
    const docs = addDocs(db, [
      testDoc("doc-prop", { entityId: propertyId, title: "Utility Bill" }),
      testDoc("doc-comp", { entityId: companyId, title: "Vendor Contract" }),
    ])
    docA = docs[0]!
    docB = docs[1]!
    listHandle = createApiHandler({
      profile,
      allowedHosts: ["core.test"],
      documents: { db },
    })
  })

  const get = (query = "", init?: RequestInit): Promise<Response> =>
    listHandle(new Request(`http://core.test/obligations${query}`, init))

  async function list(query = ""): Promise<CoreApiObligationList> {
    const response = await get(query)
    expect(response.status).toBe(200)
    const json = (await response.json()) as unknown
    const checked = validateCoreApiObligationList(json)
    if (!checked.ok) throw new Error(checked.errors.join("; "))
    return checked.value
  }

  async function errorOf(
    response: Response
  ): Promise<CoreApiError["error"] & { status: number }> {
    const body = (await response.json()) as CoreApiError
    return { status: response.status, ...body.error }
  }

  test("empty ledger returns an empty list", async () => {
    const fresh = await ledgerFixture()
    const emptyHandle = createApiHandler({
      profile: fresh.profile,
      allowedHosts: ["core.test"],
      documents: { db: fresh.db },
    })
    const response = await emptyHandle(
      new Request("http://core.test/obligations")
    )
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(body).toEqual({ obligations: [], nextOffset: null })
  })

  test("returns obligations with entity, source, status, and default draft intent", async () => {
    const oblId = await insertObligation(db, {
      entityId: propertyId,
      action: "Review contract",
      party: "Acme Corp",
      dueAt: "2026-06-01",
      status: "open",
      direction: "owed",
      docId: docA,
      span: { start: 10, end: 20 },
    })
    const body = await list()
    const found = body.obligations.find((o) => o.id === oblId)
    expect(found).toBeDefined()
    expect(found).toMatchObject({
      id: oblId,
      action: "Review contract",
      party: "Acme Corp",
      dueAt: "2026-06-01",
      status: "open",
      direction: "owed",
      hasDraftIntent: false,
      entity: {
        id: propertyId,
        name: "Test Property",
        tag: "PROP",
      },
      source: {
        documentId: docA,
        span: { start: 10, end: 20 },
        title: "Utility Bill",
      },
    })
    expect(typeof found?.updatedAt).toBe("string")
  })

  test("filters by entity", async () => {
    const compOblId = await insertObligation(db, {
      entityId: companyId,
      action: "Sign NDA",
      status: "open",
      docId: docB,
      span: { start: 0, end: 5 },
    })
    const propList = await list(`?entity=${propertyId}`)
    expect(propList.obligations.every((o) => o.entity.id === propertyId)).toBe(
      true
    )
    expect(propList.obligations.some((o) => o.id === id)).toBe(true)
    expect(propList.obligations.some((o) => o.id === compOblId)).toBe(false)

    const compList = await list(`?entity=${companyId}`)
    expect(compList.obligations.every((o) => o.entity.id === companyId)).toBe(
      true
    )
    expect(compList.obligations.some((o) => o.id === compOblId)).toBe(true)

    const unknownList = await list("?entity=non-existent")
    expect(unknownList).toEqual({ obligations: [], nextOffset: null })
  })

  test("filters by status", async () => {
    const doneId = await insertObligation(db, {
      entityId: propertyId,
      action: "Done task",
      status: "done",
      docId: docA,
      span: { start: 0, end: 5 },
    })
    const dismissedId = await insertObligation(db, {
      entityId: propertyId,
      action: "Dismissed task",
      status: "dismissed",
      docId: docA,
      span: { start: 0, end: 5 },
    })

    const openList = await list("?status=open")
    expect(openList.obligations.every((o) => o.status === "open")).toBe(true)
    expect(openList.obligations.some((o) => o.id === id)).toBe(true)

    const doneList = await list("?status=done")
    expect(doneList.obligations.every((o) => o.status === "done")).toBe(true)
    expect(doneList.obligations.some((o) => o.id === doneId)).toBe(true)

    const dismissedList = await list("?status=dismissed")
    expect(
      dismissedList.obligations.every((o) => o.status === "dismissed")
    ).toBe(true)
    expect(dismissedList.obligations.some((o) => o.id === dismissedId)).toBe(
      true
    )

    const err = await errorOf(await get("?status=unknown"))
    expect(err.status).toBe(422)
    expect(err.code).toBe("invalid")
    expect(err.fields?.[0]?.field).toBe("status")
  })

  test("filters by direction", async () => {
    const owedId = await insertObligation(db, {
      entityId: propertyId,
      action: "Reply to Tenant",
      party: "Tenant",
      dueAt: "2026-03-01",
      status: "open",
      direction: "owed",
      docId: docA,
      span: { start: 0, end: 5 },
    })
    const waitingId = await insertObligation(db, {
      entityId: propertyId,
      action: "Waiting on Contractor: Quote",
      party: "Contractor",
      dueAt: "2026-03-05",
      status: "open",
      direction: "waiting",
      docId: docA,
      span: { start: 0, end: 5 },
    })

    const owedList = await list("?direction=owed")
    expect(owedList.obligations.every((o) => o.direction === "owed")).toBe(true)
    expect(owedList.obligations.some((o) => o.id === owedId)).toBe(true)
    expect(owedList.obligations.some((o) => o.id === waitingId)).toBe(false)

    const waitingList = await list("?direction=waiting")
    expect(
      waitingList.obligations.every((o) => o.direction === "waiting")
    ).toBe(true)
    expect(waitingList.obligations.some((o) => o.id === waitingId)).toBe(true)
    expect(waitingList.obligations.some((o) => o.id === owedId)).toBe(false)

    const err = await errorOf(await get("?direction=other"))
    expect(err.status).toBe(422)
    expect(err.code).toBe("invalid")
    expect(err.fields?.[0]?.field).toBe("direction")
  })

  test("orders by due_at ASC NULLS LAST, id ASC", async () => {
    // Current 'id' from beforeEach has dueAt: null.
    const earlyId = await insertObligation(db, {
      entityId: propertyId,
      action: "Early task",
      dueAt: "2026-01-15",
      status: "open",
      docId: docA,
      span: { start: 0, end: 5 },
    })
    const laterId = await insertObligation(db, {
      entityId: propertyId,
      action: "Later task",
      dueAt: "2026-03-20",
      status: "open",
      docId: docA,
      span: { start: 0, end: 5 },
    })
    const nullId2 = await insertObligation(db, {
      entityId: propertyId,
      action: "Another null due date",
      status: "open",
      docId: docA,
      span: { start: 0, end: 5 },
    })

    const body = await list("?status=open")
    const ids = body.obligations.map((o) => o.id)
    // earlyId (2026-01-15) -> laterId (2026-03-20) -> id (null, smaller id) -> nullId2 (null, larger id)
    expect(ids).toEqual([earlyId, laterId, id, nullId2])
  })

  test("pages with limit and offset, and enforces bounds", async () => {
    for (let i = 0; i < 5; i++) {
      await insertObligation(db, {
        entityId: propertyId,
        action: `Task ${i}`,
        dueAt: `2026-01-0${i + 1}`,
        status: "open",
        docId: docA,
        span: { start: 0, end: 5 },
      })
    }
    const page1 = await list("?limit=2&status=open")
    expect(page1.obligations).toHaveLength(2)
    expect(page1.nextOffset).toBe(2)

    const page2 = await list("?limit=2&offset=2&status=open")
    expect(page2.obligations).toHaveLength(2)
    expect(page2.nextOffset).toBe(4)

    const page3 = await list("?limit=2&offset=4&status=open")
    // Total open obligations: 1 from beforeEach (null due date) + 5 = 6
    expect(page3.obligations).toHaveLength(2)
    expect(page3.nextOffset).toBeNull()

    // Out of bounds
    expect((await errorOf(await get("?limit=0"))).status).toBe(422)
    expect((await errorOf(await get("?limit=201"))).status).toBe(422)
    expect((await errorOf(await get("?limit=abc"))).status).toBe(422)
    expect((await errorOf(await get("?offset=-1"))).status).toBe(422)
    expect((await errorOf(await get("?offset=xyz"))).status).toBe(422)
  })

  test("answers only GET", async () => {
    const response = await listHandle(
      new Request("http://core.test/obligations", { method: "POST" })
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
  })

  test("is not served without documents dependency", async () => {
    const h = createApiHandler({ profile, allowedHosts: ["core.test"] })
    const response = await h(new Request("http://core.test/obligations"))
    expect(response.status).toBe(404)
  })
})
