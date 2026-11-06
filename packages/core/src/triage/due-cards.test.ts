import { describe, expect, test } from "vitest"
import { validateIntent } from "@eido/schemas"
import { fixture, putDoc, putObligation } from "../brief/brief.test-support"
import { fakeGate } from "../propose/propose.test-support"
import { createCardBuilders } from "./cards"
import { scanLedgerEvents } from "./scan"
import { triageTick } from "./tick"
import { CONFIG, NOW } from "./triage.test-support"

// Vitest's asymmetric matchers return any; nested expected values remain unknown.
const containing = (value: Record<string, unknown>): unknown =>
  expect.objectContaining(value)
const containingText = (value: string): unknown =>
  expect.stringContaining(value)

describe("ledger due-date cards", () => {
  test("scan and tick propose schema-valid all-day events from the ledger", async () => {
    const { db, entityId } = await fixture()
    try {
      const doc = putDoc(db, entityId, "due-source", NOW.toISOString())
      await putObligation(db, entityId, doc, {
        action: "Submit the property report",
        dueAt: "2026-11-02",
      })
      await putObligation(db, entityId, doc, {
        action: "Renew the inspection",
        dueAt: "2026-11-05",
      })
      const gate = fakeGate()
      await scanLedgerEvents(db, NOW, CONFIG)
      await triageTick(
        { db, gate, cards: createCardBuilders(db, NOW, CONFIG) },
        NOW,
        CONFIG
      )

      expect(
        gate.proposals.map(({ intent, origin }) => ({ intent, origin }))
      ).toEqual([
        {
          origin: "proactive",
          intent: {
            kind: "calendar.create",
            args: {
              entity: entityId,
              title: "Submit the property report",
              description: containingText(doc),
              start: "2026-11-02T00:00:00.000Z",
              end: "2026-11-02T23:59:59.999Z",
              allDay: true,
              guests: [],
            },
          },
        },
        {
          origin: "proactive",
          intent: {
            kind: "calendar.create",
            args: {
              entity: entityId,
              title: "Renew the inspection",
              description: containingText(doc),
              start: "2026-11-05T00:00:00.000Z",
              end: "2026-11-05T23:59:59.999Z",
              allDay: true,
              guests: [],
            },
          },
        },
      ])
      for (const { intent } of gate.proposals)
        expect(validateIntent(intent).ok).toBe(true)
    } finally {
      db.close()
    }
  })

  test("crossing from due-soon to due-today never proposes a second reminder", async () => {
    const { db, entityId } = await fixture()
    try {
      const doc = putDoc(db, entityId, "dedup-source", NOW.toISOString())
      await putObligation(db, entityId, doc, {
        action: "Send the quarterly report",
        dueAt: "2026-11-05",
      })
      const gate = fakeGate()
      for (const now of [NOW, new Date("2026-11-05T12:00:00.000Z")]) {
        await scanLedgerEvents(db, now, CONFIG)
        await triageTick(
          { db, gate, cards: createCardBuilders(db, now, CONFIG) },
          now,
          CONFIG
        )
      }
      expect(gate.proposals).toHaveLength(1)
      expect(gate.proposals[0]?.intent).toMatchObject({
        kind: "calendar.create",
        args: { title: "Send the quarterly report" },
      })
    } finally {
      db.close()
    }
  })

  test.each([
    ["America/Denver", "2026-11-01T05:30:00.000Z", "2026-10-31"],
    ["Europe/Zurich", "2026-03-28T23:30:00.000Z", "2026-03-29"],
    ["Pacific/Kiritimati", "2026-11-01T12:30:00.000Z", "2026-11-02"],
  ])(
    "uses the local due date in %s while preserving the writer's date markers",
    async (timezone, instant, dueAt) => {
      const { db, entityId } = await fixture()
      try {
        const now = new Date(instant)
        const cfg = { ...CONFIG, timezone }
        const doc = putDoc(db, entityId, "local-date-source", instant)
        await putObligation(db, entityId, doc, {
          action: "Renew the permit",
          dueAt,
        })
        const gate = fakeGate()
        await scanLedgerEvents(db, now, cfg)
        await triageTick(
          { db, gate, cards: createCardBuilders(db, now, cfg) },
          now,
          cfg
        )
        expect(gate.proposals).toEqual([
          expect.objectContaining({
            origin: "proactive",
            intent: containing({
              kind: "calendar.create",
              args: containing({
                start: `${dueAt}T00:00:00.000Z`,
                end: `${dueAt}T23:59:59.999Z`,
                allDay: true,
              }),
            }),
          }),
        ])
      } finally {
        db.close()
      }
    }
  )

  test.each(["closed", "moved", "past"] as const)(
    "a queued due event that is now %s produces no stale reminder",
    async (change) => {
      const { db, entityId } = await fixture()
      try {
        const doc = putDoc(db, entityId, "changed-source", NOW.toISOString())
        const id = await putObligation(db, entityId, doc, {
          action: "Check the insurance",
          dueAt: "2026-11-02",
        })
        await scanLedgerEvents(db, NOW, CONFIG)
        if (change === "closed")
          db.prepare("UPDATE obligations SET status = 'done' WHERE id = ?").run(
            id
          )
        if (change === "moved")
          db.prepare(
            "UPDATE obligations SET due_at = '2026-11-12' WHERE id = ?"
          ).run(id)
        const now =
          change === "past" ? new Date("2026-11-03T12:00:00.000Z") : NOW
        const gate = fakeGate()
        await triageTick(
          { db, gate, cards: createCardBuilders(db, now, CONFIG) },
          now,
          CONFIG
        )
        expect(gate.proposals).toEqual([])
      } finally {
        db.close()
      }
    }
  )
})
