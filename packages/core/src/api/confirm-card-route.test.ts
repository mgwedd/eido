import { afterEach, describe, expect, test } from "vitest"
import { GateRequestError, GateUnavailableError } from "@eido/gate"
import type { IntentProposal, IntentStatus, ProposeResult } from "@eido/gate"
import {
  validateCoreApiConfirmCardResponse,
  validateCoreApiError,
  validateIntent,
} from "@eido/schemas"
import type { ExtractedFields } from "@eido/schemas"
import type { DatabaseSync } from "node:sqlite"
import { fixture, putDoc, unconfirmedAmount } from "../brief/brief.test-support"
import { confirmExtractionField } from "../ledger/confirm"
import { insertExtraction } from "../ledger/store"
import { emitEvent } from "../triage/store"
import { CONFIG, NOW } from "../triage/triage.test-support"
import { createProfileStore } from "../profile/index"
import { openIndex } from "../index/schema"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"
import { createConfirmCardResolver } from "./confirm-card-route"

let active: DatabaseSync | undefined
afterEach(() => {
  active?.close()
  active = undefined
})

type StatusAnswer = Partial<IntentStatus> | GateRequestError

/** A gate fake: records proposals, stores each as pending, and answers `status` from a table. */
function gateFake(
  options: {
    propose?: (n: number) => ProposeResult | Error
    statuses?: Record<string, StatusAnswer>
  } = {}
) {
  const proposals: IntentProposal[] = []
  const statusCalls: string[] = []
  return {
    proposals,
    statusCalls,
    propose: (proposal: IntentProposal): Promise<ProposeResult> => {
      proposals.push(proposal)
      const answer = options.propose?.(proposals.length) ?? {
        id: `int_${String(proposals.length)}`,
        tier: "approval",
        state: "pending",
      }
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer)
    },
    status: (id: string): Promise<IntentStatus> => {
      statusCalls.push(id)
      const answer = options.statuses?.[id]
      if (answer === undefined)
        return Promise.reject(
          new GateRequestError(404, "not_found", "no such intent")
        )
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({
            id,
            kind: "confirm.field",
            tier: "approval",
            state: "pending",
            edited_from: null,
            discarded: false,
            ...answer,
          })
    },
  }
}

async function setup(gate = gateFake()) {
  const f = await fixture()
  active = f.db
  const doc = putDoc(f.db, f.entityId, "confirm-source", NOW.toISOString())
  const resolver = createConfirmCardResolver({
    db: f.db,
    gate,
    config: () => Promise.resolve(CONFIG),
    now: () => NOW,
  })
  return { ...f, doc, gate, resolver }
}

function extraction(
  db: DatabaseSync,
  docId: string,
  confidence: Record<string, number>,
  over: { status?: "extracted" | "processed_empty" } = {}
): Promise<number> {
  const all: ExtractedFields = {
    action: { raw: "Renew the lease", span: { start: 0, end: 15 } },
    party: { raw: "Example Supply", span: { start: 20, end: 34 } },
    amount: {
      raw: "CHF 120.00",
      span: { start: 40, end: 50 },
      status: "parsed",
      value: { amount_minor: 12000, currency: "CHF" },
    },
  }
  // A field is present exactly when it has a confidence.
  const fields: ExtractedFields = {}
  if (confidence["action"] !== undefined) fields.action = all.action
  if (confidence["party"] !== undefined) fields.party = all.party
  if (confidence["amount"] !== undefined) fields.amount = all.amount
  return insertExtraction(db, {
    docId,
    schema: "obligations",
    status: over.status ?? "extracted",
    fields,
    confidence,
    model: "synthetic",
    createdAt: NOW.toISOString(),
  })
}

describe("confirm-card resolver", () => {
  test("proposes the lowest-confidence field through the gate when no card is pending", async () => {
    const { db, doc, resolver, gate } = await setup()
    const id = await extraction(db, doc, {
      action: 0.95,
      party: 0.5,
      amount: 0.3,
    })
    const result = await resolver(id)
    expect(result).toEqual({
      ok: true,
      status: 201,
      body: {
        intentId: "int_1",
        field: "amount",
        created: true,
        queueHref: "/queue?intent=int_1",
      },
    })
    expect(gate.proposals).toHaveLength(1)
    const [proposal] = gate.proposals
    expect(proposal?.origin).toBe("proactive")
    expect(proposal?.intent).toMatchObject({
      kind: "confirm.field",
      args: { extractionId: String(id), field: "amount" },
    })
    expect(validateIntent(proposal?.intent).ok).toBe(true)
  })

  test("breaks a confidence tie by field name", async () => {
    const { db, doc, resolver } = await setup()
    const id = await extraction(db, doc, { party: 0.5, amount: 0.5 })
    expect(await resolver(id)).toMatchObject({
      ok: true,
      body: { field: "amount" },
    })
  })

  test("skips a confirmed field and picks the next lowest", async () => {
    const { db, doc, resolver } = await setup()
    const id = await extraction(db, doc, { party: 0.6, amount: 0.3 })
    await confirmExtractionField(db, {
      extractionId: id,
      field: "amount",
      now: NOW.toISOString(),
    })
    expect(await resolver(id)).toMatchObject({
      ok: true,
      body: { field: "party" },
    })
  })

  test("repeated calls return the same intent and propose once", async () => {
    const gate = gateFake({ statuses: { int_1: {} } })
    const { db, doc, resolver } = await setup(gate)
    const id = await unconfirmedAmount(db, doc, 0.4)
    const first = await resolver(id)
    const second = await resolver(id)
    const third = await resolver(id)
    expect(first).toMatchObject({
      status: 201,
      body: { intentId: "int_1", created: true },
    })
    for (const again of [second, third])
      expect(again).toMatchObject({
        status: 200,
        body: { intentId: "int_1", created: false },
      })
    expect(gate.proposals).toHaveLength(1)
  })

  test("concurrent calls for one extraction propose once", async () => {
    const gate = gateFake({ statuses: { int_1: {} } })
    const { db, doc, resolver } = await setup(gate)
    const id = await unconfirmedAmount(db, doc, 0.4)
    const results = await Promise.all([resolver(id), resolver(id)])
    expect(gate.proposals).toHaveLength(1)
    expect(results.map((r) => (r.ok ? r.body.intentId : r.code))).toEqual([
      "int_1",
      "int_1",
    ])
  })

  test("returns the pending card triage already proposed for the field", async () => {
    const gate = gateFake({ statuses: { "card-from-triage": {} } })
    const { db, doc, resolver } = await setup(gate)
    const id = await unconfirmedAmount(db, doc, 0.4)
    const event = emitEvent(db, {
      source: "extraction",
      kind: "confirm-field",
      triggerKey: `extraction:${String(id)}:confirm:amount`,
      fireId: "amount",
      ref: `ext:${String(id)}`,
      signals: {},
      receivedAt: NOW.toISOString(),
    })
    db.prepare(
      "UPDATE events SET disposition='card', intent_id='card-from-triage', decided_at=? WHERE id=?"
    ).run(NOW.toISOString(), event.id)
    expect(await resolver(id)).toMatchObject({
      status: 200,
      body: { intentId: "card-from-triage", field: "amount", created: false },
    })
    expect(gate.proposals).toEqual([])
  })

  test("proposes a new card when the stored intent is no longer pending", async () => {
    const statuses: Record<string, StatusAnswer> = { int_1: {} }
    const gate = gateFake({ statuses })
    const { db, doc, resolver } = await setup(gate)
    const id = await unconfirmedAmount(db, doc, 0.4)
    await resolver(id)
    statuses["int_1"] = { state: "approved" }
    expect(await resolver(id)).toMatchObject({
      status: 201,
      body: { intentId: "int_2", created: true },
    })
    expect(gate.proposals).toHaveLength(2)
  })

  test("proposes a new card when the gate no longer knows the stored intent", async () => {
    const gate = gateFake()
    const { db, doc, resolver } = await setup(gate)
    const id = await unconfirmedAmount(db, doc, 0.4)
    await resolver(id)
    // int_1 has no status entry: the fake answers 404 for it.
    expect(await resolver(id)).toMatchObject({
      status: 201,
      body: { intentId: "int_2", created: true },
    })
  })

  test("a stored intent of another kind is not reused", async () => {
    const gate = gateFake({ statuses: { int_1: { kind: "email.draft" } } })
    const { db, doc, resolver } = await setup(gate)
    const id = await unconfirmedAmount(db, doc, 0.4)
    await resolver(id)
    expect(await resolver(id)).toMatchObject({
      body: { intentId: "int_2", created: true },
    })
  })

  test("a missing extraction is not found and proposes nothing", async () => {
    const { resolver, gate } = await setup()
    expect(await resolver(9999)).toMatchObject({ ok: false, code: "not_found" })
    expect(gate.proposals).toEqual([])
  })

  test("a confirmed extraction is not found and proposes nothing", async () => {
    const { db, doc, resolver, gate } = await setup()
    const id = await unconfirmedAmount(db, doc, 0.4)
    await confirmExtractionField(db, {
      extractionId: id,
      field: "amount",
      now: NOW.toISOString(),
    })
    expect(await resolver(id)).toMatchObject({ ok: false, code: "not_found" })
    expect(gate.proposals).toEqual([])
  })

  test("an extraction that extracted nothing is not found", async () => {
    const { db, doc, resolver, gate } = await setup()
    const id = await extraction(db, doc, {}, { status: "processed_empty" })
    expect(await resolver(id)).toMatchObject({ ok: false, code: "not_found" })
    expect(gate.proposals).toEqual([])
  })

  test("an extraction with only confident fields is not found", async () => {
    const { db, doc, resolver, gate } = await setup()
    const id = await extraction(db, doc, { action: 0.95, party: 0.9 })
    expect(await resolver(id)).toMatchObject({ ok: false, code: "not_found" })
    expect(gate.proposals).toEqual([])
  })

  test("a gate refusal is reported as gate_refused, not as a card", async () => {
    const gate = gateFake({
      propose: () =>
        new GateRequestError(422, "invalid_payload", "bad", ["args.field"]),
    })
    const { db, doc, resolver } = await setup(gate)
    const id = await unconfirmedAmount(db, doc, 0.4)
    expect(await resolver(id)).toMatchObject({
      ok: false,
      code: "gate_refused",
    })
  })

  test("a policy-rejected intent is reported as gate_refused and remembered nowhere", async () => {
    const gate = gateFake({
      propose: (n) =>
        n === 1
          ? { id: "int_rej", tier: "approval", state: "rejected" }
          : { id: "int_ok", tier: "approval", state: "pending" },
    })
    const { db, doc, resolver } = await setup(gate)
    const id = await unconfirmedAmount(db, doc, 0.4)
    expect(await resolver(id)).toMatchObject({
      ok: false,
      code: "gate_refused",
    })
    // The rejected id was not stored as the card: the next call proposes afresh.
    expect(await resolver(id)).toMatchObject({
      ok: true,
      body: { intentId: "int_ok", created: true },
    })
  })

  test("an unreachable gate is thrown for the handler to answer", async () => {
    const gate = gateFake({
      propose: () => new GateUnavailableError("the gate is not reachable"),
    })
    const { db, doc, resolver } = await setup(gate)
    const id = await unconfirmedAmount(db, doc, 0.4)
    await expect(resolver(id)).rejects.toBeInstanceOf(GateUnavailableError)
  })

  test("a failing status lookup other than 404 is thrown, not treated as no card", async () => {
    const gate = gateFake({
      statuses: {
        int_1: new GateUnavailableError("the gate is not reachable"),
      },
    })
    const { db, doc, resolver } = await setup(gate)
    const id = await unconfirmedAmount(db, doc, 0.4)
    await resolver(id)
    await expect(resolver(id)).rejects.toBeInstanceOf(GateUnavailableError)
    expect(gate.proposals).toHaveLength(1)
  })
})

describe("POST /extractions/confirm-card", () => {
  async function route(gate = gateFake()) {
    const s = await setup(gate)
    const index = openIndex(":memory:")
    const handle: ApiHandler = createApiHandler({
      profile: createProfileStore(index),
      allowedHosts: ["core.test"],
      confirmCard: s.resolver,
    })
    const post = (body: unknown): Promise<Response> =>
      handle(
        new Request("http://core.test/extractions/confirm-card", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        })
      )
    return { ...s, handle, post, close: () => index.close() }
  }

  async function errorOf(response: Response) {
    const checked = validateCoreApiError(await response.json())
    if (!checked.ok) throw new Error(checked.errors.join("; "))
    return checked.value.error
  }

  test("a proposed card answers 201 with a schema-valid body linking the queue", async () => {
    const r = await route()
    const id = await unconfirmedAmount(r.db, r.doc, 0.4)
    const response = await r.post({ extractionId: id })
    expect(response.status).toBe(201)
    const checked = validateCoreApiConfirmCardResponse(await response.json())
    if (!checked.ok) throw new Error(checked.errors.join("; "))
    expect(checked.value).toEqual({
      intentId: "int_1",
      field: "amount",
      created: true,
      queueHref: "/queue?intent=int_1",
    })
    r.close()
  })

  test("an existing pending card answers 200 created false", async () => {
    const r = await route(gateFake({ statuses: { int_1: {} } }))
    const id = await unconfirmedAmount(r.db, r.doc, 0.4)
    await r.post({ extractionId: id })
    const again = await r.post({ extractionId: id })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({
      intentId: "int_1",
      created: false,
    })
    r.close()
  })

  test("an unknown extraction answers 404 not_found", async () => {
    const r = await route()
    const response = await r.post({ extractionId: 4242 })
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe("not_found")
    expect(r.gate.proposals).toEqual([])
    r.close()
  })

  test("a gate refusal answers 422 gate_refused", async () => {
    const r = await route(
      gateFake({
        propose: () => new GateRequestError(422, "invalid_payload", "bad"),
      })
    )
    const id = await unconfirmedAmount(r.db, r.doc, 0.4)
    const response = await r.post({ extractionId: id })
    expect(response.status).toBe(422)
    expect((await errorOf(response)).code).toBe("gate_refused")
    r.close()
  })

  test("an unreachable gate answers 503 gate_unavailable", async () => {
    const r = await route(
      gateFake({ propose: () => new GateUnavailableError("down") })
    )
    const id = await unconfirmedAmount(r.db, r.doc, 0.4)
    const response = await r.post({ extractionId: id })
    expect(response.status).toBe(503)
    expect((await errorOf(response)).code).toBe("gate_unavailable")
    r.close()
  })

  test.each([
    ["no id", {}],
    ["a zero id", { extractionId: 0 }],
    ["a string id", { extractionId: "12" }],
    ["an extra property", { extractionId: 1, field: "amount" }],
  ])("%s answers 422 invalid and proposes nothing", async (_name, body) => {
    const r = await route()
    const response = await r.post(body)
    expect(response.status).toBe(422)
    expect((await errorOf(response)).code).toBe("invalid")
    expect(r.gate.proposals).toEqual([])
    r.close()
  })

  test("other methods are not allowed", async () => {
    const r = await route()
    const response = await r.handle(
      new Request("http://core.test/extractions/confirm-card", {
        method: "GET",
      })
    )
    expect(response.status).toBe(405)
    r.close()
  })

  test("without a resolver the route is not served", async () => {
    const index = openIndex(":memory:")
    const handle = createApiHandler({
      profile: createProfileStore(index),
      allowedHosts: ["core.test"],
    })
    const response = await handle(
      new Request("http://core.test/extractions/confirm-card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extractionId: 1 }),
      })
    )
    expect(response.status).toBe(404)
    index.close()
  })
})
