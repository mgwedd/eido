import { afterEach, describe, expect, test } from "vitest"
import { validateIntent } from "@eido/schemas"
import type { ExtractedFields } from "@eido/schemas"
import type { DatabaseSync } from "node:sqlite"
import { fixture, putDoc, unconfirmedAmount } from "../brief/brief.test-support"
import { insertExtraction } from "../ledger/store"
import { confirmExtractionField } from "../ledger/confirm"
import { fakeGate } from "../propose/propose.test-support"
import { createCardBuilders } from "./cards"
import { scanLedgerEvents } from "./scan"
import { triageTick } from "./tick"
import { emitEvent } from "./store"
import { CONFIG, NOW, rows } from "./triage.test-support"

// Vitest's asymmetric matcher returns any; keep nested expected values typed as unknown.
const containing = (value: Record<string, unknown>): unknown =>
  expect.objectContaining(value)

let active: DatabaseSync | undefined
afterEach(() => {
  active?.close()
  active = undefined
})

async function setup() {
  const f = await fixture()
  active = f.db
  const doc = putDoc(f.db, f.entityId, "confirm-source", NOW.toISOString())
  return { ...f, doc }
}

const tick = (
  db: DatabaseSync,
  gate: ReturnType<typeof fakeGate>,
  cfg = CONFIG
) => triageTick({ db, gate, cards: createCardBuilders(db, NOW, cfg) }, NOW, cfg)

describe("ledger confirmation cards", () => {
  test("a scan proposes each low-confidence field once with its original source", async () => {
    const { db, doc } = await setup()
    const fields: ExtractedFields = {
      action: { raw: "Pay the invoice", span: { start: 0, end: 15 } },
      amount: {
        raw: "CHF 120.00",
        span: { start: 30, end: 40, page: 2 },
        status: "parsed",
        value: { amount_minor: 12000, currency: "CHF" },
      },
      party: { raw: "Example Supply", span: { start: 50, end: 64 } },
    }
    const id = await insertExtraction(db, {
      docId: doc,
      schema: "obligations",
      status: "extracted",
      fields,
      confidence: { action: 0.95, amount: 0.4, party: 0.5 },
      model: "synthetic",
      createdAt: NOW.toISOString(),
    })
    const gate = fakeGate()
    await scanLedgerEvents(db, NOW, CONFIG)
    await tick(db, gate)
    expect(gate.proposals.map((p) => p.intent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "confirm.field",
          args: containing({
            extractionId: String(id),
            field: "amount",
            value: {
              raw: "CHF 120.00",
              typed: { amount_minor: 12000, currency: "CHF" },
            },
            source: { docSha256: doc, start: 30, end: 40, page: 2 },
          }),
        }),
        expect.objectContaining({
          kind: "confirm.field",
          args: containing({
            extractionId: String(id),
            field: "party",
          }),
        }),
      ])
    )
    expect(gate.proposals).toHaveLength(2)
    for (const proposal of gate.proposals) {
      expect(proposal.origin).toBe("proactive")
      expect(validateIntent(proposal.intent).ok).toBe(true)
    }
    // The local confirmation was skipped: the field remains flagged, but its card is not repeated.
    await scanLedgerEvents(db, NOW, CONFIG)
    await tick(db, gate)
    expect(gate.proposals).toHaveLength(2)
  })

  test("a parse failure needs confirmation even at high confidence and below the score floor", async () => {
    const { db, doc } = await setup()
    await insertExtraction(db, {
      docId: doc,
      schema: "obligations",
      status: "extracted",
      fields: {
        action: { raw: "Renew the lease", span: { start: 0, end: 15 } },
        due_date: {
          raw: "when convenient",
          span: { start: 20, end: 35 },
          status: "parse_failed",
          value: null,
        },
      },
      confidence: { action: 1, due_date: 0.95 },
      model: "synthetic",
      createdAt: NOW.toISOString(),
    })
    const gate = fakeGate()
    await scanLedgerEvents(db, NOW, CONFIG)
    await tick(db, gate)
    expect(gate.proposals.map((p) => p.intent)).toEqual([
      expect.objectContaining({
        kind: "confirm.field",
        args: containing({
          field: "due_date",
          value: { raw: "when convenient", typed: null },
        }),
      }),
    ])
  })

  test("two flagged fields share the daily card budget", async () => {
    const { db, doc, entityId } = await setup()
    await unconfirmedAmount(db, doc, 0.4)
    const other = putDoc(
      db,
      entityId,
      "second-confirm-source",
      NOW.toISOString()
    )
    await unconfirmedAmount(db, other, 0.4)
    const gate = fakeGate()
    const cfg = { ...CONFIG, cardBudget: { perDay: 1 } }
    await scanLedgerEvents(db, NOW, cfg)
    expect(await tick(db, gate, cfg)).toMatchObject({
      cards: 1,
      digest: 1,
      remainingBudget: 0,
    })
    expect(gate.proposals).toHaveLength(1)
    expect(rows(db, "disposition = 'digest'").map((r) => r["reason"])).toEqual([
      "budget",
    ])
  })

  test("a queued field confirmed elsewhere produces no stale card", async () => {
    const { db, doc } = await setup()
    const id = await unconfirmedAmount(db, doc, 0.4)
    await scanLedgerEvents(db, NOW, CONFIG)
    await confirmExtractionField(db, {
      extractionId: id,
      field: "amount",
      now: NOW.toISOString(),
    })
    const gate = fakeGate()
    await tick(db, gate)
    expect(gate.proposals).toEqual([])
  })

  test("an already-carded legacy extraction event suppresses new field events", async () => {
    const { db, doc } = await setup()
    const id = await unconfirmedAmount(db, doc, 0.4)
    const event = emitEvent(db, {
      source: "extraction",
      kind: "confirm-field",
      triggerKey: `extraction:${String(id)}:confirm`,
      fireId: "extracted",
      ref: `ext:${String(id)}`,
      signals: {},
      receivedAt: NOW.toISOString(),
    })
    db.prepare(
      "UPDATE events SET disposition='card', intent_id='legacy-card', decided_at=? WHERE id=?"
    ).run(NOW.toISOString(), event.id)
    expect(await scanLedgerEvents(db, NOW, CONFIG)).toEqual({ emitted: 0 })
    expect(rows(db).map((r) => r["intent_id"])).toEqual(["legacy-card"])
  })
})
