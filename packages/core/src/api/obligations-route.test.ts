import type { DatabaseSync } from "node:sqlite"
import { GateUnavailableError } from "@eido/gate"
import { beforeEach, describe, expect, test } from "vitest"
import { addDocs, ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import { createObligationStateStore } from "../ledger/obligation-state"
import type {
  ObligationAuditEntry,
  ObligationAuditSink,
} from "../ledger/obligation-state"
import { insertObligation, listObligations } from "../ledger/store"
import type { ProfileStore } from "../profile/store"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"

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
  const fixture = await ledgerFixture()
  db = fixture.db
  profile = fixture.profile
  const [docId = ""] = addDocs(db, [
    testDoc("a", { entityId: fixture.property.id }),
  ])
  id = insertObligation(db, {
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

  test("answers 503 busy while another store's transaction is open", async () => {
    db.exec("BEGIN")
    try {
      const response = await post(`/obligations/${String(id)}/done`)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: { code: "busy" } })
    } finally {
      db.exec("ROLLBACK")
    }
  })

  test("is not served without an obligation store", async () => {
    const h = createApiHandler({ profile, allowedHosts: ["core.test"] })
    expect(
      (await post(`/obligations/${String(id)}/done`, "{}", h)).status
    ).toBe(404)
  })
})
