import { afterEach, describe, expect, it, vi } from "vitest"
import { verifyChain } from "./audit"
import { payloadHash } from "./canonical"
import { checkDrift } from "./connectors"
import {
  editIntent,
  intentHistory,
  intentStatus,
  pendingIntents,
  propose,
  recordUndo,
  transition,
} from "./intents"
import type { IntentState, ProposeResult } from "./intents"
import {
  BODY_MARKER,
  CALENDAR_OPS,
  FILE_OPS,
  MAIL_OPS,
  OWNER,
  auditRows,
  loggedText,
  manifest,
  sample,
  setup,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

// Asymmetric matchers are typed any; holding one as unknown keeps the literals typed.
const anyString: unknown = expect.any(String)

let current: Setup | undefined

function fresh(...args: Parameters<typeof setup>): Setup {
  current = setup(...args)
  return current
}

afterEach(() => {
  current?.cleanup()
  current = undefined
})

function ok(result: ProposeResult): Extract<ProposeResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`)
  return result
}

function intentCount(s: Setup): number {
  return Number(s.db.prepare("SELECT count(*) AS n FROM intents").get()?.["n"])
}

function proposeKind(s: Setup, intent: unknown): ProposeResult {
  return propose(s.db, s.policy, { intent, origin: "reactive" })
}

/** A fresh intent in `state`, reached along legal edges. */
function intentIn(s: Setup, state: IntentState): string {
  if (state === "pending" || state === "rejected") {
    const { intentId } = ok(proposeKind(s, sample("email.send")))
    if (state === "rejected") transition(s.db, intentId, "rejected", "approver")
    return intentId
  }
  const { intentId } = ok(proposeKind(s, sample("email.archive")))
  if (state === "executed" || state === "failed") {
    transition(s.db, intentId, state, "executor")
  }
  return intentId
}

describe("proposing", () => {
  it("an invalid payload returns invalid_payload, stores nothing and is audited", () => {
    const s = fresh()
    const result = proposeKind(s, { kind: "email.send", args: { to: [] } })
    expect(result).toMatchObject({ ok: false, code: "invalid_payload" })
    expect(result.ok ? [] : result.errors).not.toEqual([])
    expect(intentCount(s)).toBe(0)
    expect(pendingIntents(s.db)).toEqual([])
    expect(auditRows(s.db).at(-1)).toMatchObject({
      actor: "data-plane",
      action: "intent.invalid",
      target: "intent",
    })
  })

  it("a payload that is not canonical JSON is invalid", () => {
    const s = fresh()
    const result = proposeKind(s, sample("email.draft", { body: "\ud800" }))
    expect(result).toEqual({
      ok: false,
      code: "invalid_payload",
      errors: ["$: not representable as canonical JSON"],
    })
    expect(intentCount(s)).toBe(0)
  })

  it("the gate computes the payload hash over the canonical intent", () => {
    const s = fresh()
    const intent = sample("email.send")
    const result = ok(proposeKind(s, intent))
    expect(result.payloadHash).toBe(payloadHash(intent))
    const row = s.db
      .prepare("SELECT payload_json, payload_hash FROM intents WHERE id = ?")
      .get(result.intentId)
    expect(row?.["payload_hash"]).toBe(payloadHash(intent))
    expect(JSON.parse(String(row?.["payload_json"]))).toEqual(intent)
  })

  it("a forbidden intent is stored rejected with its reason and audited", () => {
    const s = fresh()
    const result = proposeKind(s, sample("file.delete", { root: "secrets" }))
    expect(result).toEqual({
      ok: false,
      code: "forbidden",
      intentId: anyString,
      errors: ["root_not_allowed"],
    })
    const id = "intentId" in result ? result.intentId : ""
    expect(intentStatus(s.db, id)).toEqual({
      state: "rejected",
      tier: "forbidden",
    })
    expect(
      s.db.prepare("SELECT reason FROM intents WHERE id = ?").get(id)?.[
        "reason"
      ]
    ).toBe("root_not_allowed")
    expect(auditRows(s.db).filter((r) => r.target === id)).toEqual([
      expect.objectContaining({
        action: "intent.proposed",
        actor: "data-plane",
      }),
      expect.objectContaining({ action: "intent.transition", actor: "policy" }),
    ])
  })

  it("an intent for a drift-disabled connector is rejected with connector_disabled", () => {
    const s = fresh()
    checkDrift(s.db, "mail", ["send"])
    const result = proposeKind(s, sample("email.send"))
    expect(result).toEqual({
      ok: false,
      code: "connector_disabled",
      intentId: anyString,
      errors: ["connector_disabled"],
    })
    const id = "intentId" in result ? result.intentId : ""
    expect(intentStatus(s.db, id)).toEqual({
      state: "rejected",
      tier: "forbidden",
    })
  })

  it("an approval intent lands in pending and stays there; nothing schedules an expiry", () => {
    const s = fresh()
    vi.useFakeTimers()
    const result = ok(proposeKind(s, sample("email.send")))
    expect(result).toMatchObject({ tier: "approval", state: "pending" })
    expect(intentStatus(s.db, result.intentId)).toEqual({
      state: "pending",
      tier: "approval",
    })
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    expect(() =>
      s.db
        .prepare("UPDATE intents SET state = 'expired' WHERE id = ?")
        .run(result.intentId)
    ).toThrow(/CHECK constraint/)
  })

  it("an auto intent lands in approved, set by policy", () => {
    const s = fresh()
    const result = ok(proposeKind(s, sample("email.archive")))
    expect(result).toMatchObject({ tier: "auto", state: "approved" })
    expect(intentHistory(s.db, result.intentId).map((e) => e.actor)).toEqual([
      "data-plane",
      "policy",
    ])
  })

  it("stores origin, task and context pack ids", () => {
    const s = fresh()
    const { intentId } = ok(
      propose(s.db, s.policy, {
        intent: sample("email.send"),
        origin: "task",
        taskId: "task-1",
        contextPackId: "pack-1",
      })
    )
    expect(
      s.db
        .prepare(
          "SELECT origin, task_id, context_pack_id FROM intents WHERE id = ?"
        )
        .get(intentId)
    ).toEqual({ origin: "task", task_id: "task-1", context_pack_id: "pack-1" })
  })
})

describe("transitions", () => {
  const illegal: Array<[IntentState, IntentState]> = [
    ["approved", "pending"],
    ["pending", "executed"],
    ["executed", "pending"],
    ["failed", "approved"],
    ["rejected", "pending"],
  ]
  it.each(illegal)("%s -> %s throws", (from, to) => {
    const s = fresh()
    const id = intentIn(s, from)
    expect(() => transition(s.db, id, to, "executor")).toThrow(
      `illegal intent transition ${from} -> ${to}`
    )
    expect(intentStatus(s.db, id)?.state).toBe(from)
  })

  it("proposed -> executed throws", () => {
    const s = fresh()
    const { intentId } = ok(proposeKind(s, sample("email.send")))
    s.db
      .prepare("UPDATE intents SET state = 'proposed' WHERE id = ?")
      .run(intentId)
    expect(() => transition(s.db, intentId, "executed", "executor")).toThrow(
      "illegal intent transition proposed -> executed"
    )
  })

  it("there is no expired state", () => {
    const s = fresh()
    const id = intentIn(s, "pending")
    // @ts-expect-error: "expired" is not an intent state; the edge table must refuse it too.
    expect(() => transition(s.db, id, "expired", "system")).toThrow(
      "illegal intent transition pending -> expired"
    )
  })

  it("only the named actor may take an edge", () => {
    const s = fresh()
    const id = intentIn(s, "pending")
    expect(() => transition(s.db, id, "approved", "data-plane")).toThrow(
      "data-plane may not move an intent from pending to approved"
    )
    transition(s.db, id, "approved", "approver")
    expect(() => transition(s.db, id, "executed", "approver")).toThrow(
      "approver may not move an intent from approved to executed"
    )
    transition(s.db, id, "executed", "executor")
    expect(intentStatus(s.db, id)?.state).toBe("executed")
  })

  it("an unknown intent throws", () => {
    const s = fresh()
    expect(() => transition(s.db, "nope", "approved", "approver")).toThrow(
      "unknown intent nope"
    )
  })

  it("a transition and its audit row roll back together", () => {
    const s = fresh()
    const id = intentIn(s, "pending")
    const rowsBefore = auditRows(s.db).length
    s.db.exec(
      "CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END"
    )
    expect(() => transition(s.db, id, "approved", "approver")).toThrow(
      "audit down"
    )
    s.db.exec("DROP TRIGGER fail_audit")
    expect(intentStatus(s.db, id)?.state).toBe("pending")
    expect(auditRows(s.db)).toHaveLength(rowsBefore)
  })

  it("a transition inside the caller's transaction commits or rolls back with it", () => {
    const s = fresh()
    const id = intentIn(s, "pending")
    const rowsBefore = auditRows(s.db).length
    s.db.exec("BEGIN")
    transition(s.db, id, "approved", "approver")
    s.db.exec("ROLLBACK")
    expect(intentStatus(s.db, id)?.state).toBe("pending")
    expect(auditRows(s.db)).toHaveLength(rowsBefore)

    s.db.exec("BEGIN")
    s.db.exec(
      "CREATE TEMP TRIGGER fail_events BEFORE INSERT ON intent_events BEGIN SELECT RAISE(ABORT, 'events down'); END"
    )
    expect(() => transition(s.db, id, "approved", "approver")).toThrow(
      "events down"
    )
    s.db.exec("DROP TRIGGER fail_events")
    expect(intentStatus(s.db, id)?.state).toBe("pending")
    expect(auditRows(s.db)).toHaveLength(rowsBefore)
    s.db.exec("COMMIT")
  })

  it("a proposal rolls back whole when its audit append fails", () => {
    const s = fresh()
    s.db.exec(
      "CREATE TEMP TRIGGER fail_events BEFORE INSERT ON intent_events WHEN NEW.to_state = 'pending' BEGIN SELECT RAISE(ABORT, 'events down'); END"
    )
    expect(() => proposeKind(s, sample("email.send"))).toThrow("events down")
    expect(intentCount(s)).toBe(0)
    expect(verifyChain(s.db).ok).toBe(true)
  })
})

describe("editing", () => {
  it("rejects the original with reason edited and creates a pending intent linked to it", () => {
    const s = fresh()
    const original = ok(
      propose(s.db, s.policy, {
        intent: sample("email.send"),
        origin: "proactive",
        taskId: "task-1",
        contextPackId: "pack-1",
      })
    ).intentId
    const edited = sample("email.send", { subject: "Changed" })
    const result = editIntent(s.db, s.policy, original, edited, "approver")
    expect(result).toEqual({
      ok: true,
      intentId: anyString,
      tier: "approval",
      state: "pending",
      payloadHash: payloadHash(edited),
    })
    const id = result.ok ? result.intentId : ""
    expect(intentStatus(s.db, original)).toEqual({
      state: "rejected",
      tier: "approval",
    })
    expect(
      s.db
        .prepare(
          "SELECT edited_from, origin, task_id, context_pack_id FROM intents WHERE id = ?"
        )
        .get(id)
    ).toEqual({
      edited_from: original,
      origin: "proactive",
      task_id: "task-1",
      context_pack_id: "pack-1",
    })
    expect(pendingIntents(s.db).map((p) => p.id)).toEqual([id])
  })

  it("re-runs policy: an edit that drops the only other guest would make it auto, so it is refused", () => {
    const s = fresh()
    const original = ok(
      proposeKind(
        s,
        sample("calendar.create", { guests: ["guest@example.com"] })
      )
    )
    expect(original.state).toBe("pending")
    const result = editIntent(
      s.db,
      s.policy,
      original.intentId,
      sample("calendar.create"),
      "approver"
    )
    expect(result).toEqual({ ok: false, code: "tier_changed" })
    expect(intentStatus(s.db, original.intentId)?.state).toBe("pending")
    expect(intentCount(s)).toBe(1)
  })

  it("refuses an edit that makes the payload forbidden; the original stays pending", () => {
    const s = fresh()
    const { intentId } = ok(proposeKind(s, sample("file.delete")))
    const result = editIntent(
      s.db,
      s.policy,
      intentId,
      sample("file.delete", { root: "secrets" }),
      "approver"
    )
    expect(result).toEqual({
      ok: false,
      code: "forbidden",
      errors: ["root_not_allowed"],
    })
    expect(intentStatus(s.db, intentId)?.state).toBe("pending")
    expect(intentCount(s)).toBe(1)
  })

  it("refuses an edit of a non-pending intent", () => {
    const s = fresh()
    const { intentId } = ok(proposeKind(s, sample("email.archive")))
    expect(
      editIntent(s.db, s.policy, intentId, sample("email.archive"), "approver")
    ).toEqual({ ok: false, code: "not_pending" })
  })

  it("refuses an edit that changes the kind", () => {
    const s = fresh()
    const { intentId } = ok(proposeKind(s, sample("email.send")))
    expect(
      editIntent(s.db, s.policy, intentId, sample("email.reply"), "approver")
    ).toEqual({ ok: false, code: "kind_changed" })
    expect(intentStatus(s.db, intentId)?.state).toBe("pending")
  })

  it("refuses an invalid edit and an edit of an unknown intent", () => {
    const s = fresh()
    const { intentId } = ok(proposeKind(s, sample("email.send")))
    const invalid = editIntent(
      s.db,
      s.policy,
      intentId,
      { kind: "email.send", args: {} },
      "approver"
    )
    expect(invalid).toMatchObject({ ok: false, code: "invalid_payload" })
    expect(invalid.ok ? [] : invalid.errors).not.toEqual([])
    expect(
      editIntent(s.db, s.policy, "nope", sample("email.send"), "approver")
    ).toEqual({ ok: false, code: "not_found" })
  })

  it("audits every refusal against the original", () => {
    const s = fresh()
    const { intentId } = ok(proposeKind(s, sample("email.send")))
    const newIntent = sample("email.reply")
    editIntent(s.db, s.policy, intentId, newIntent, "approver")
    expect(auditRows(s.db).at(-1)).toEqual(
      expect.objectContaining({
        actor: "approver",
        action: "intent.edit_refused",
        target: intentId,
        detail_hash: payloadHash({
          from: "pending",
          to: "pending",
          reason: "kind_changed",
          payload_hash: payloadHash(newIntent),
        }),
      })
    )
  })
})

describe("history", () => {
  it("lists every transition in seq order, with null from first", () => {
    const s = fresh()
    const { intentId } = ok(proposeKind(s, sample("email.send")))
    transition(s.db, intentId, "approved", "approver")
    transition(s.db, intentId, "executed", "executor")
    const history = intentHistory(s.db, intentId)
    expect(history.map(({ from, to, actor }) => ({ from, to, actor }))).toEqual(
      [
        { from: null, to: "proposed", actor: "data-plane" },
        { from: "proposed", to: "pending", actor: "policy" },
        { from: "pending", to: "approved", actor: "approver" },
        { from: "approved", to: "executed", actor: "executor" },
      ]
    )
    const stamps = s.db
      .prepare(
        "SELECT a.ts FROM intent_events e JOIN audit_log a ON a.seq = e.audit_seq WHERE e.intent_id = ? ORDER BY a.seq"
      )
      .all(intentId)
      .map((row) => String(row["ts"]))
    expect(history.map((e) => e.at)).toEqual(stamps)
  })

  it("shows an edit on both intents", () => {
    const s = fresh()
    const { intentId: original } = ok(proposeKind(s, sample("email.send")))
    const edit = editIntent(
      s.db,
      s.policy,
      original,
      sample("email.send", { subject: "Changed" }),
      "approver"
    )
    const id = edit.ok ? edit.intentId : ""
    expect(intentHistory(s.db, original).at(-1)).toMatchObject({
      from: "pending",
      to: "rejected",
      actor: "approver",
      reason: "edited",
    })
    expect(intentHistory(s.db, id)).toMatchObject([
      { from: null, to: "proposed", actor: "approver", reason: "edited" },
      { from: "proposed", to: "pending", actor: "policy" },
    ])
    expect(pendingIntents(s.db)).toEqual([
      expect.objectContaining({ id, editedFrom: original }),
    ])
  })

  it("an undo appears in history while the status stays executed", () => {
    const s = fresh()
    const { intentId } = ok(proposeKind(s, sample("email.archive")))
    expect(() => recordUndo(s.db, intentId, payloadHash({ x: 1 }))).toThrow(
      "only an executed intent can be undone, not approved"
    )
    transition(s.db, intentId, "executed", "executor")
    recordUndo(s.db, intentId, payloadHash({ inverse: "unarchive" }))
    expect(intentHistory(s.db, intentId).at(-1)).toMatchObject({
      from: "executed",
      to: "executed",
      actor: "executor",
      reason: "undone",
    })
    expect(intentStatus(s.db, intentId)).toEqual({
      state: "executed",
      tier: "auto",
    })
    expect(() => recordUndo(s.db, "nope", payloadHash({}))).toThrow(
      "unknown intent nope"
    )
  })

  it("carries no payload field", () => {
    const s = fresh()
    const { intentId } = ok(proposeKind(s, sample("email.send")))
    const history = intentHistory(s.db, intentId)
    for (const entry of history) {
      expect(Object.keys(entry).sort()).toEqual(
        "reason" in entry
          ? ["actor", "at", "from", "reason", "to"]
          : ["actor", "at", "from", "to"]
      )
    }
    expect(JSON.stringify(history)).not.toContain(BODY_MARKER)
  })

  it("a stored state outside the state set is reported, not passed on", () => {
    const s = fresh()
    const { intentId } = ok(proposeKind(s, sample("email.send")))
    s.db.exec("PRAGMA ignore_check_constraints = ON")
    s.db
      .prepare("UPDATE intents SET state = 'expired' WHERE id = ?")
      .run(intentId)
    expect(() => intentStatus(s.db, intentId)).toThrow(
      "stored intent state expired is unknown"
    )
  })
})

describe("the pending list", () => {
  it("returns exactly the pending intents, oldest first, with no payload", () => {
    const s = fresh()
    const first = ok(proposeKind(s, sample("email.send"))).intentId
    ok(proposeKind(s, sample("email.archive")))
    const second = ok(
      propose(s.db, s.policy, {
        intent: sample("file.delete"),
        origin: "proactive",
      })
    ).intentId
    const third = ok(proposeKind(s, sample("email.trash"))).intentId
    transition(s.db, third, "rejected", "approver", "not now")
    proposeKind(s, sample("file.delete", { root: "secrets" }))
    const list = pendingIntents(s.db)
    expect(list).toEqual([
      {
        id: first,
        kind: "email.send",
        tier: "approval",
        state: "pending",
        origin: "reactive",
        createdAt: anyString,
      },
      {
        id: second,
        kind: "file.delete",
        tier: "approval",
        state: "pending",
        origin: "proactive",
        createdAt: anyString,
      },
    ])
    expect(JSON.stringify(list)).not.toContain(BODY_MARKER)
  })
})

describe("the audit trail", () => {
  it("every step and refusal is logged, the chain verifies, and no payload body is logged", () => {
    const s = fresh([
      manifest("mail", MAIL_OPS),
      manifest("calendar", CALENDAR_OPS),
      manifest("files", FILE_OPS),
    ])
    const before = auditRows(s.db).length
    const send = ok(proposeKind(s, sample("email.send"))).intentId // 2 rows
    ok(proposeKind(s, sample("calendar.create", { guests: [OWNER] }))) // 2 rows
    proposeKind(s, sample("file.move", { root: "secrets" })) // 2 rows
    proposeKind(s, { kind: "email.send", args: { body: BODY_MARKER } }) // 1 row
    editIntent(s.db, s.policy, send, sample("email.reply"), "approver") // 1 row
    editIntent(
      s.db,
      s.policy,
      send,
      sample("email.send", { subject: BODY_MARKER }),
      "approver"
    ) // 3 rows
    expect(auditRows(s.db).length - before).toBe(11)
    expect(verifyChain(s.db).ok).toBe(true)
    expect(loggedText(s.db)).not.toContain(BODY_MARKER)
  })

  it("the transition detail hash covers from, to, reason and payload hash", () => {
    const s = fresh()
    const intent = sample("email.send")
    const { intentId } = ok(proposeKind(s, intent))
    transition(s.db, intentId, "rejected", "approver", "not now")
    expect(auditRows(s.db).at(-1)?.detail_hash).toBe(
      payloadHash({
        from: "pending",
        to: "rejected",
        reason: "not now",
        payload_hash: payloadHash(intent),
      })
    )
    expect(
      s.db.prepare("SELECT reason FROM intents WHERE id = ?").get(intentId)?.[
        "reason"
      ]
    ).toBe("not now")
  })
})
