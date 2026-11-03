import { describe, expect, test } from "vitest"
import {
  NOW as BRIEF_NOW,
  fixture,
  putDoc,
  putObligation,
  unconfirmedAmount,
} from "../brief/brief.test-support"
import { fakeGate } from "../propose/propose.test-support"
import { scanLedgerEvents } from "./scan"
import { triageTick } from "./tick"
import { ALL_CARDS, CONFIG, rows } from "./triage.test-support"

// 13:00 in Zurich on 2026-11-02; the local date is 2026-11-02.
const NOW = BRIEF_NOW
const INGESTED = "2026-11-02T06:00:00.000Z"

function kinds(db: Awaited<ReturnType<typeof fixture>>["db"]): string[] {
  return rows(db).map((r) => `${String(r["kind"])}@${String(r["ref"])}`)
}

describe("scanLedgerEvents", () => {
  test("raises one due event per obligation at its stage: overdue, today, soon", async () => {
    const { db, entityId } = await fixture()
    const doc = putDoc(db, entityId, "bills", INGESTED)
    const overdue = await putObligation(db, entityId, doc, {
      action: "A",
      dueAt: "2026-10-30",
    })
    const today = await putObligation(db, entityId, doc, {
      action: "B",
      dueAt: "2026-11-02",
    })
    const soon = await putObligation(db, entityId, doc, {
      action: "C",
      dueAt: "2026-11-09",
    })
    await putObligation(db, entityId, doc, { action: "D", dueAt: "2026-11-10" })
    await scanLedgerEvents(db, NOW, CONFIG)
    expect(kinds(db).sort()).toEqual(
      [
        `overdue@obl:${String(overdue)}`,
        `due-today@obl:${String(today)}`,
        `due-soon@obl:${String(soon)}`,
        // D is 8 days out: not soon, but ingested recently, so it is a new obligation.
        "new-obligation@obl:4",
      ].sort()
    )
    expect(rows(db, "kind = 'overdue'")[0]).toMatchObject({
      source: "due",
      fire_id: "overdue:2026-10-30",
      trigger_key: `obligation:${String(overdue)}:due`,
    })
  })

  test("scans are idempotent and a moved due date fires again", async () => {
    const { db, entityId } = await fixture()
    const doc = putDoc(db, entityId, "bills", INGESTED)
    const id = await putObligation(db, entityId, doc, {
      action: "A",
      dueAt: "2026-11-05",
    })
    expect((await scanLedgerEvents(db, NOW, CONFIG)).emitted).toBe(1)
    expect((await scanLedgerEvents(db, NOW, CONFIG)).emitted).toBe(0)
    // Later, the same obligation crosses into today: a new stage, a new event.
    const later = new Date("2026-11-05T10:00:00Z")
    expect((await scanLedgerEvents(db, later, CONFIG)).emitted).toBe(1)
    expect(
      rows(db)
        .map((r) => r["fire_id"])
        .sort()
    ).toEqual(["due-soon:2026-11-05", "due-today:2026-11-05"])
    db.prepare("UPDATE obligations SET due_at = '2026-11-07' WHERE id = ?").run(
      id
    )
    expect((await scanLedgerEvents(db, later, CONFIG)).emitted).toBe(1)
  })

  test("ignores closed obligations and obligations ingested before the lookback", async () => {
    const { db, entityId } = await fixture()
    const fresh = putDoc(db, entityId, "fresh", INGESTED)
    const old = putDoc(db, entityId, "old", "2026-10-01T06:00:00.000Z")
    await putObligation(db, entityId, fresh, { action: "done", status: "done" })
    await putObligation(db, entityId, old, { action: "stale" })
    const kept = await putObligation(db, entityId, fresh, { action: "keep" })
    await scanLedgerEvents(db, NOW, CONFIG)
    expect(kinds(db)).toEqual([`new-obligation@obl:${String(kept)}`])
  })

  test("a reply owed or waited on is a candidate even when the message was read", async () => {
    const { db, entityId } = await fixture()
    const doc = putDoc(db, entityId, "thread", "2026-10-20T06:00:00.000Z")
    db.prepare(
      "INSERT INTO document_text (sha256, title, body, occurred_at) VALUES (?, 'Re: lease', 'body', '2026-10-28T12:00:00.000Z')"
    ).run(doc)
    // The ledger keeps no read state: the mail was read in Gmail, yet it is still emitted.
    const owed = await putObligation(db, entityId, doc, {
      action: "Reply to the agent",
      direction: "owed",
      threadId: "th-1",
      anchorMessageId: "m-1@example.invalid",
    })
    await scanLedgerEvents(db, NOW, CONFIG)
    expect(rows(db)[0]).toMatchObject({
      source: "reply",
      kind: "reply-owed",
      ref: `obl:${String(owed)}`,
      fire_id: "m-1@example.invalid",
    })
    // Five days of thread age: 0.35 + 0.05.
    expect(rows(db)[0]?.["score"]).toBeCloseTo(0.4, 5)
  })

  test("waiting-on is a different kind from reply-owed", async () => {
    const { db, entityId } = await fixture()
    const doc = putDoc(db, entityId, "thread", INGESTED)
    await putObligation(db, entityId, doc, {
      action: "Await the plumber",
      direction: "waiting",
      anchorMessageId: "m-2@example.invalid",
    })
    await scanLedgerEvents(db, NOW, CONFIG)
    expect(rows(db)[0]?.["kind"]).toBe("waiting-on")
  })

  test("an unconfirmed low-confidence extraction raises a confirm-field event carrying money", async () => {
    const { db, entityId } = await fixture()
    const doc = putDoc(db, entityId, "invoice", INGESTED)
    const low = await unconfirmedAmount(db, doc, 0.4)
    const doc2 = putDoc(db, entityId, "invoice2", INGESTED)
    await unconfirmedAmount(db, doc2, 0.95)
    await scanLedgerEvents(db, NOW, CONFIG)
    expect(rows(db)).toHaveLength(1)
    expect(rows(db)[0]).toMatchObject({
      source: "extraction",
      kind: "confirm-field",
      ref: `ext:${String(low)}`,
    })
    expect(rows(db)[0]?.["score"]).toBeCloseTo(0.4, 5) // 0.25 + 0.15 for the amount
  })

  test("an obligation whose document carries an amount scores higher", async () => {
    const { db, entityId } = await fixture()
    const paid = putDoc(db, entityId, "paid", INGESTED)
    const plain = putDoc(db, entityId, "plain", INGESTED)
    await unconfirmedAmount(db, paid, 0.95)
    await putObligation(db, entityId, paid, { action: "with amount" })
    await putObligation(db, entityId, plain, { action: "without" })
    await scanLedgerEvents(db, NOW, CONFIG)
    const scores = rows(db, "kind = 'new-obligation'").map((r) => r["score"])
    expect(scores.sort()).toEqual([0.3, 0.45])
  })

  test("events from a scan flow through a tick into cards and the digest", async () => {
    const { db, entityId } = await fixture()
    const doc = putDoc(db, entityId, "bills", INGESTED)
    const dues = [
      "2026-10-31",
      "2026-11-02",
      ...["03", "04", "05", "06", "07", "08"].map((d) => `2026-11-${d}`),
    ]
    for (const dueAt of dues)
      await putObligation(db, entityId, doc, { action: `Bill ${dueAt}`, dueAt })
    await scanLedgerEvents(db, NOW, CONFIG)
    const result = await triageTick(
      { db, gate: fakeGate(), cards: ALL_CARDS },
      NOW,
      CONFIG
    )
    expect(result).toMatchObject({ cards: 5, digest: 3 })
    const fires = (where: string): string[] =>
      rows(db, where).map((r) => String(r["fire_id"]))
    // The overdue and due-today bills and the two nearest due-soon ones hold the cards.
    expect(fires("disposition = 'card'")).toEqual(
      expect.arrayContaining([
        "overdue:2026-10-31",
        "due-today:2026-11-02",
        "due-soon:2026-11-03",
        "due-soon:2026-11-04",
      ])
    )
    for (const fire of fires("disposition = 'digest'"))
      expect(
        ["05", "06", "07", "08"].map((d) => `due-soon:2026-11-${d}`)
      ).toContain(fire)
  })

  test("rejects an invalid config", async () => {
    const { db } = await fixture()
    expect(() =>
      scanLedgerEvents(db, NOW, { ...CONFIG, timezone: "Nowhere/Land" })
    ).toThrow(/timezone/)
  })
})
