import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GateRequestError, GateUnavailableError } from "@eido/gate"
import { describe, expect, test } from "vitest"
import { openDataDb } from "../ledger/db"
import { fakeGate } from "../propose/propose.test-support"
import type { TriageConfig } from "./config"
import { emitEvent, listDigestEvents, markShownInBrief } from "./store"
import { triageTick } from "./tick"
import {
  ALL_CARDS,
  CONFIG,
  NOW,
  emit,
  event,
  openDb,
  reminderCard,
  rows,
} from "./triage.test-support"

const withBudget = (perDay: number, over: Partial<TriageConfig> = {}) => ({
  ...CONFIG,
  ...over,
  cardBudget: { perDay },
})

describe("budget", () => {
  test("a flood of 500 events in one tick creates exactly perDay cards and loses none", async () => {
    const db = openDb()
    const gate = fakeGate()
    for (let i = 0; i < 500; i++)
      emit(db, { signals: { moneyPresent: i % 2 === 0, threadAgeDays: i % 9 } })
    const result = await triageTick({ db, gate, cards: ALL_CARDS }, NOW, CONFIG)
    expect(result).toEqual({
      cards: 5,
      digest: 495,
      ledger: 0,
      remainingBudget: 0,
    })
    expect(gate.proposals).toHaveLength(5)
    expect(rows(db, "disposition IS NULL")).toHaveLength(0)
    expect(rows(db, "disposition = 'card'")).toHaveLength(5)
    expect(
      rows(db, "disposition = 'digest' AND reason = 'budget'")
    ).toHaveLength(495)
    expect(rows(db)).toHaveLength(500)
  })

  test("a flood across several ticks in one day still creates perDay cards", async () => {
    const db = openDb()
    const gate = fakeGate()
    const deps = { db, gate, cards: ALL_CARDS }
    let cards = 0
    for (const [minutes, count] of [
      [0, 200],
      [30, 200],
      [90, 100],
    ] as const) {
      for (let i = 0; i < count; i++)
        emit(db, { signals: { threadAgeDays: i } })
      const at = new Date(NOW.getTime() + minutes * 60_000)
      cards += (await triageTick(deps, at, CONFIG)).cards
    }
    expect(cards).toBe(5)
    expect(gate.proposals).toHaveLength(5)
    expect(rows(db, "disposition IS NULL")).toHaveLength(0)
    expect(rows(db)).toHaveLength(500)
  })

  test("the highest-score events get the cards", async () => {
    const db = openDb()
    // Reply-owed scores 0.35 plus 0.01 per day of thread age: ages 0..9 give ten distinct scores.
    for (const age of [4, 9, 0, 7, 2, 5, 8, 1, 6, 3])
      emit(db, {
        kind: "reply-owed",
        ref: `age:${String(age)}`,
        signals: { threadAgeDays: age },
      })
    await triageTick({ db, gate: fakeGate(), cards: ALL_CARDS }, NOW, CONFIG)
    expect(
      rows(db, "disposition = 'card'")
        .map((r) => r["ref"])
        .sort()
    ).toEqual(["age:5", "age:6", "age:7", "age:8", "age:9"])
  })

  test("a lower-score event is not carded ahead of a higher one that arrived later", async () => {
    const db = openDb()
    const gate = fakeGate()
    const low = emit(db, { signals: {} })
    const high = emit(db, { kind: "overdue", signals: { daysToDue: -2 } })
    await triageTick({ db, gate, cards: ALL_CARDS }, NOW, withBudget(1))
    expect(rows(db, `id = '${high}'`)[0]?.["disposition"]).toBe("card")
    expect(rows(db, `id = '${low}'`)[0]).toMatchObject({
      disposition: "digest",
      reason: "budget",
    })
  })

  test("the cap follows the configured perDay", async () => {
    for (const perDay of [0, 2, 8]) {
      const db = openDb()
      const gate = fakeGate()
      for (let i = 0; i < 20; i++) emit(db)
      const result = await triageTick(
        { db, gate, cards: ALL_CARDS },
        NOW,
        withBudget(perDay)
      )
      expect(result.cards).toBe(perDay)
      expect(gate.proposals).toHaveLength(perDay)
    }
  })

  test("a confirm-field card uses one unit of the same budget", async () => {
    const db = openDb()
    const gate = fakeGate()
    const confirm = emit(db, {
      kind: "confirm-field",
      source: "extraction",
      signals: { moneyPresent: true },
    })
    for (let i = 0; i < 3; i++) emit(db, { signals: { threadAgeDays: i } })
    const result = await triageTick(
      { db, gate, cards: ALL_CARDS },
      NOW,
      withBudget(2)
    )
    expect(result.cards).toBe(2)
    expect(rows(db, `id = '${confirm}'`)[0]?.["disposition"]).toBe("card")
    expect(
      rows(db, "disposition = 'card' AND kind = 'new-obligation'")
    ).toHaveLength(1)
  })

  test("events below ledgerOnlyBelow are recorded in the ledger and use no budget", async () => {
    const db = openDb()
    const gate = fakeGate()
    emit(db, { kind: "waiting-on", signals: {} }) // 0.2
    emit(db, { kind: "waiting-on", signals: { moneyPresent: true } }) // 0.35
    const result = await triageTick({ db, gate, cards: ALL_CARDS }, NOW, CONFIG)
    expect(result).toMatchObject({ cards: 1, ledger: 1, remainingBudget: 4 })
    expect(rows(db, "disposition = 'ledger'")[0]?.["reason"]).toBe("low-score")
  })

  test("raising ledgerOnlyBelow moves the same event to the ledger", async () => {
    const db = openDb()
    emit(db, { signals: {} }) // 0.3
    const result = await triageTick(
      { db, gate: fakeGate(), cards: ALL_CARDS },
      NOW,
      { ...CONFIG, ledgerOnlyBelow: 0.31 }
    )
    expect(result.ledger).toBe(1)
  })
})

describe("every card goes through the intent API as proactive", () => {
  test("origin is proactive and the stored intent id is kept", async () => {
    const db = openDb()
    const gate = fakeGate()
    emit(db)
    emit(db, { signals: { threadAgeDays: 2 } })
    await triageTick({ db, gate, cards: ALL_CARDS }, NOW, CONFIG)
    expect(gate.proposals.map((p) => p.origin)).toEqual([
      "proactive",
      "proactive",
    ])
    expect(
      rows(db, "disposition = 'card'")
        .map((r) => r["intent_id"])
        .sort()
    ).toEqual(["int_1", "int_2"])
  })

  test("an event kind with no card builder goes to the digest", async () => {
    const db = openDb()
    const gate = fakeGate()
    emit(db, { kind: "confirm-field", signals: { moneyPresent: true } })
    const result = await triageTick(
      { db, gate, cards: { "new-obligation": reminderCard } },
      NOW,
      CONFIG
    )
    expect(result).toMatchObject({ cards: 0, digest: 1, remainingBudget: 5 })
    expect(gate.proposals).toHaveLength(0)
    expect(rows(db)[0]?.["reason"]).toBe("no_card_builder")
  })
})

describe("gate refusal", () => {
  test("a refused intent falls to the digest with the reason and uses no budget", async () => {
    const db = openDb()
    const gate = fakeGate([
      new GateRequestError(422, "invalid_payload", "refused"),
      { id: "int_ok", tier: "approval", state: "pending" },
    ])
    const refused = emit(db, { signals: { moneyPresent: true } })
    const next = emit(db)
    const result = await triageTick(
      { db, gate, cards: ALL_CARDS },
      NOW,
      withBudget(1)
    )
    expect(rows(db, `id = '${refused}'`)[0]).toMatchObject({
      disposition: "digest",
      reason: "gate_refused:invalid_payload",
      intent_id: null,
    })
    // The refusal consumed nothing, so the next event still got the single card.
    expect(rows(db, `id = '${next}'`)[0]?.["disposition"]).toBe("card")
    expect(result).toMatchObject({ cards: 1, digest: 1, remainingBudget: 0 })
  })

  test("a policy-rejected intent is not a card", async () => {
    const db = openDb()
    const gate = fakeGate([
      {
        id: "int_x",
        tier: "forbidden",
        state: "rejected",
        reason: "connector_disabled",
      },
    ])
    emit(db)
    const result = await triageTick({ db, gate, cards: ALL_CARDS }, NOW, CONFIG)
    expect(result).toMatchObject({ cards: 0, digest: 1, remainingBudget: 5 })
    expect(rows(db)[0]).toMatchObject({
      disposition: "digest",
      reason: "gate_rejected:connector_disabled",
      intent_id: null,
    })
  })

  test("an unreachable gate sends the event to the digest", async () => {
    const db = openDb()
    emit(db)
    const gate = {
      propose: () => Promise.reject(new GateUnavailableError("down")),
    }
    await triageTick({ db, gate, cards: ALL_CARDS }, NOW, CONFIG)
    expect(rows(db)[0]).toMatchObject({
      disposition: "digest",
      reason: "gate_unavailable",
    })
  })

  test("an unexpected error is not swallowed and leaves the event queued", async () => {
    const db = openDb()
    emit(db)
    const gate = { propose: () => Promise.reject(new TypeError("bug")) }
    await expect(
      triageTick({ db, gate, cards: ALL_CARDS }, NOW, CONFIG)
    ).rejects.toThrow("bug")
    expect(rows(db)[0]?.["disposition"]).toBeNull()
    // The next tick still runs.
    const result = await triageTick(
      { db, gate: fakeGate(), cards: ALL_CARDS },
      NOW,
      CONFIG
    )
    expect(result.cards).toBe(1)
  })
})

describe("regeneration", () => {
  test("emitting the same trigger and fire again records nothing", () => {
    const db = openDb()
    const first = emitEvent(
      db,
      event({ triggerKey: "obligation:9:due", fireId: "d1" })
    )
    const again = emitEvent(
      db,
      event({ triggerKey: "obligation:9:due", fireId: "d1" })
    )
    expect(first.deduped).toBe(false)
    expect(again).toEqual({ id: first.id, deduped: true })
    expect(rows(db)).toHaveLength(1)
  })

  test("re-running the same events creates no new cards", async () => {
    const db = openDb()
    const gate = fakeGate()
    const batch = [1, 2, 3].map((n) =>
      event({ triggerKey: `thing:${String(n)}`, fireId: "f1" })
    )
    const deps = { db, gate, cards: ALL_CARDS }
    for (const e of batch) emitEvent(db, e)
    await triageTick(deps, NOW, CONFIG)
    for (const e of batch) emitEvent(db, e)
    const result = await triageTick(deps, NOW, CONFIG)
    expect(result).toMatchObject({ cards: 0, digest: 0, ledger: 0 })
    expect(gate.proposals).toHaveLength(3)
    expect(rows(db)).toHaveLength(3)
  })

  test("a restart on the same file neither re-emits nor re-spends the budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-"))
    try {
      const path = join(dir, "eido-data.db")
      const first = openDataDb(path)
      for (let i = 0; i < 3; i++)
        emitEvent(first, event({ triggerKey: `t:${String(i)}`, fireId: "f" }))
      await triageTick(
        { db: first, gate: fakeGate(), cards: ALL_CARDS },
        NOW,
        withBudget(2)
      )
      first.close()

      const second = openDataDb(path)
      const gate = fakeGate()
      for (let i = 0; i < 3; i++)
        emitEvent(second, event({ triggerKey: `t:${String(i)}`, fireId: "f" }))
      const result = await triageTick(
        { db: second, gate, cards: ALL_CARDS },
        NOW,
        withBudget(2)
      )
      expect(result).toMatchObject({ cards: 0, remainingBudget: 0 })
      expect(gate.proposals).toHaveLength(0)
      expect(rows(second, "disposition = 'card'")).toHaveLength(2)
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a rejected card is not recreated, but the same trigger firing again can create one", async () => {
    const db = openDb()
    const gate = fakeGate()
    const deps = { db, gate, cards: ALL_CARDS }
    const key = "obligation:7:reply"
    emitEvent(
      db,
      event({ triggerKey: key, fireId: "msg-1", kind: "reply-owed" })
    )
    await triageTick(deps, NOW, CONFIG)
    expect(gate.proposals).toHaveLength(1)
    // The owner rejects the intent at the gate; nothing in the data plane changes. A sweep
    // that re-emits the same firing finds it recorded and proposes nothing.
    emitEvent(
      db,
      event({ triggerKey: key, fireId: "msg-1", kind: "reply-owed" })
    )
    await triageTick(deps, NOW, CONFIG)
    expect(gate.proposals).toHaveLength(1)
    // A new message on the thread fires the trigger again.
    emitEvent(
      db,
      event({ triggerKey: key, fireId: "msg-2", kind: "reply-owed" })
    )
    await triageTick(deps, NOW, CONFIG)
    expect(gate.proposals).toHaveLength(2)
    expect(
      rows(db, `trigger_key = '${key}' AND disposition = 'card'`)
    ).toHaveLength(2)
  })

  test("a new firing with no budget left goes to the digest", async () => {
    const db = openDb()
    const deps = { db, gate: fakeGate(), cards: ALL_CARDS }
    const cfg = withBudget(1)
    emitEvent(db, event({ triggerKey: "k", fireId: "a" }))
    await triageTick(deps, NOW, cfg)
    emitEvent(db, event({ triggerKey: "k", fireId: "b" }))
    await triageTick(deps, NOW, cfg)
    expect(rows(db, "fire_id = 'b'")[0]).toMatchObject({
      disposition: "digest",
      reason: "budget",
    })
  })
})

describe("the day boundary", () => {
  const at = (iso: string): Date => new Date(iso)
  const newYork = (perDay: number): TriageConfig =>
    withBudget(perDay, { timezone: "America/New_York" })

  async function cardsAt(
    db: ReturnType<typeof openDb>,
    when: string,
    cfg: TriageConfig,
    count = 3
  ): Promise<number> {
    for (let i = 0; i < count; i++) emit(db)
    return (
      await triageTick(
        { db, gate: fakeGate(), cards: ALL_CARDS },
        at(when),
        cfg
      )
    ).cards
  }

  test("resets at local midnight across the spring-forward change", async () => {
    const db = openDb()
    const cfg = newYork(2)
    // 23:30 on 7 March (EST), then 00:00 on 8 March (EST), the day that has 23 hours.
    expect(await cardsAt(db, "2026-03-08T04:30:00Z", cfg)).toBe(2)
    expect(await cardsAt(db, "2026-03-08T04:59:00Z", cfg)).toBe(0)
    expect(await cardsAt(db, "2026-03-08T05:00:00Z", cfg)).toBe(2)
    // 8 March ends at 00:00 EDT on the 9th, 04:00 UTC: 23 hours after it began.
    expect(await cardsAt(db, "2026-03-09T03:59:00Z", cfg)).toBe(0)
    expect(await cardsAt(db, "2026-03-09T04:00:00Z", cfg)).toBe(2)
  })

  test("resets at local midnight across the fall-back change", async () => {
    const db = openDb()
    const cfg = newYork(2)
    expect(await cardsAt(db, "2026-11-01T04:30:00Z", cfg)).toBe(2) // 00:30 EDT, 1 Nov
    // 23:30 EST, still 1 Nov: 24 hours after the first cards, but the day has 25 hours.
    expect(await cardsAt(db, "2026-11-02T04:30:00Z", cfg)).toBe(0)
    expect(await cardsAt(db, "2026-11-02T05:00:00Z", cfg)).toBe(2) // 00:00 EST, 2 Nov
  })

  test("the day is the configured timezone's, not UTC's", async () => {
    const utc = openDb()
    const auckland = openDb()
    // 23:00 on 1 June in Auckland (UTC+12) is 11:00 UTC; two hours later it is 2 June there.
    const cfgUtc = withBudget(2, { timezone: "UTC" })
    const cfgAuckland = withBudget(2, { timezone: "Pacific/Auckland" })
    await cardsAt(utc, "2026-06-01T11:00:00Z", cfgUtc)
    await cardsAt(auckland, "2026-06-01T11:00:00Z", cfgAuckland)
    expect(await cardsAt(utc, "2026-06-01T13:00:00Z", cfgUtc)).toBe(0)
    expect(await cardsAt(auckland, "2026-06-01T13:00:00Z", cfgAuckland)).toBe(2)
  })
})

describe("digest overflow", () => {
  test("lists overflow events with their ref, best first, and leaves out the rest", async () => {
    const db = openDb()
    const cfg = withBudget(1)
    const top = emit(db, {
      kind: "overdue",
      signals: { daysToDue: -1 },
      ref: "obl:1",
    })
    const second = emit(db, { signals: { moneyPresent: true }, ref: "obl:2" })
    const third = emit(db, { signals: {}, ref: "obl:3" })
    emit(db, { kind: "waiting-on", signals: {}, ref: "obl:4" }) // ledger only
    await triageTick({ db, gate: fakeGate(), cards: ALL_CARDS }, NOW, cfg)
    const listed = listDigestEvents(db, new Date(NOW.getTime() - 1000))
    expect(listed.map((e) => [e.id, e.ref, e.reason])).toEqual([
      [second, "obl:2", "budget"],
      [third, "obl:3", "budget"],
    ])
    expect(listed.map((e) => e.id)).not.toContain(top)
  })

  test("leaves out events decided before `since` and events already shown", async () => {
    const db = openDb()
    const cfg = withBudget(0)
    const old = emit(db, { ref: "obl:old" })
    await triageTick({ db, gate: fakeGate(), cards: ALL_CARDS }, NOW, cfg)
    const later = new Date(NOW.getTime() + 3_600_000)
    const fresh = emit(db, { ref: "obl:fresh" })
    const shown = emit(db, { ref: "obl:shown" })
    await triageTick({ db, gate: fakeGate(), cards: ALL_CARDS }, later, cfg)
    markShownInBrief(db, [shown], later)
    expect(
      listDigestEvents(db, new Date(NOW.getTime() + 1000)).map((e) => e.id)
    ).toEqual([fresh])
    expect(
      listDigestEvents(db, new Date(NOW.getTime() - 1000))
        .map((e) => e.id)
        .sort()
    ).toEqual([old, fresh].sort())
  })

  test("marking a card or ledger event shown changes nothing", async () => {
    const db = openDb()
    const card = emit(db)
    await triageTick({ db, gate: fakeGate(), cards: ALL_CARDS }, NOW, CONFIG)
    markShownInBrief(db, [card], NOW)
    expect(rows(db)[0]?.["shown_in_brief_at"]).toBeNull()
  })
})

describe("configuration", () => {
  test.each([
    [{ ...CONFIG, cardBudget: { perDay: -1 } }, /perDay/],
    [{ ...CONFIG, cardBudget: { perDay: 1.5 } }, /perDay/],
    [{ ...CONFIG, ledgerOnlyBelow: 1.2 }, /ledgerOnlyBelow/],
    [{ ...CONFIG, timezone: "Mars/Olympus" }, /timezone/],
    [{ ...CONFIG, scan: { ...CONFIG.scan, lookbackDays: 0 } }, /lookbackDays/],
    [{ ...CONFIG, scan: { ...CONFIG.scan, dueSoonDays: -1 } }, /dueSoonDays/],
    [
      { ...CONFIG, scan: { ...CONFIG.scan, confirmThreshold: 2 } },
      /confirmThreshold/,
    ],
  ])("rejects an invalid config", (cfg, message) => {
    const db = openDb()
    expect(() =>
      triageTick({ db, gate: fakeGate(), cards: ALL_CARDS }, NOW, cfg)
    ).toThrow(message)
  })
})
