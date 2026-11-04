import { describe, expect, it, vi } from "vitest"
import type { GateConnectorHealth } from "@eido/schemas"
import { openIndex } from "../../index/schema"
import { assignSimpleFinAccount, pendingBackfillAccounts } from "./accounts"
import { parseAccountSet, SimpleFinError } from "./client"
import type { SimpleFinClient } from "./client"
import { SIMPLEFIN_SYNC_INTERVAL_MS } from "./config"
import { createSimpleFinRuntime, withSimpleFinStatus } from "./runtime"
import type { SyncTime } from "./config"

// Synthetic accounts only.

const NOW_MS = Date.parse("2026-03-01T00:00:00.000Z")
const ACCOUNT_SET = {
  errors: ["Lorem notice"],
  accounts: [
    {
      id: "acc_1",
      name: "Lorem",
      currency: "USD",
      balance: "987.65",
      transactions: [
        {
          id: "t1",
          posted: NOW_MS / 1000 - 60,
          amount: "-1.00",
          description: "Ipsum",
        },
      ],
    },
  ],
}

function setup(
  options: {
    answer?: () => Promise<unknown>
    health?: GateConnectorHealth["connectors"]
    /** Assign acc_1 to ent_a before the first sync, as Settings would. */
    assigned?: boolean
    syncTime?: SyncTime
    startMs?: number
  } = {}
) {
  const db = openIndex(":memory:")
  db.exec(
    "INSERT INTO entities (id, kind, name, tag, created_at) VALUES ('ent_a', 'personal', 'A', 'A', '2026-01-01T00:00:00Z')"
  )
  if (options.assigned === true) {
    db.exec(
      "INSERT INTO accounts (id, connector, name, currency, entity_id) VALUES ('acc_1', 'simplefin', 'Lorem', 'USD', 'ent_a')"
    )
  }
  let answer = options.answer ?? (() => Promise.resolve(ACCOUNT_SET))
  const getAccounts = vi.fn(async () => parseAccountSet(await answer()))
  const client: SimpleFinClient = { getAccounts }
  const log =
    vi.fn<(event: string, fields?: Readonly<Record<string, string>>) => void>()
  let clock = options.startMs ?? NOW_MS
  let health = options.health ?? []
  const runtime = createSimpleFinRuntime({
    db,
    gate: { getConnectorHealth: () => Promise.resolve(health) },
    client,
    ...(options.syncTime === undefined ? {} : { syncTime: options.syncTime }),
    log,
    now: () => clock,
  })
  return {
    db,
    runtime,
    getAccounts,
    log,
    advance: (ms: number) => {
      clock += ms
    },
    set: (ms: number) => {
      clock = ms
    },
    setHealth: (next: GateConnectorHealth["connectors"]) => {
      health = next
    },
    setAnswer: (next: () => Promise<unknown>) => {
      answer = next
    },
  }
}

describe("SimpleFIN runtime", () => {
  it("syncs, logs counts only, and skips until the interval has passed", async () => {
    const { runtime, getAccounts, log, advance } = setup({ assigned: true })
    await runtime.sync()
    expect(log.mock.calls).toEqual([
      [
        "simplefin_synced",
        {
          windows: "1",
          transactions: "1",
          linked: "0",
          rejected: "0",
          unassigned: "0",
        },
      ],
    ])
    expect(runtime.messages()).toEqual(["Lorem notice"])
    advance(SIMPLEFIN_SYNC_INTERVAL_MS - 1)
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(1)
    advance(1)
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(2)
  })

  it("reports accounts without an entity", async () => {
    const { runtime } = setup()
    await runtime.sync()
    expect(runtime.messages()).toEqual([
      "1 account needs an entity",
      "Lorem notice",
    ])
  })

  it("runs one sync at a time", async () => {
    const { runtime, getAccounts } = setup()
    await Promise.all([runtime.sync(), runtime.sync()])
    expect(getAccounts).toHaveBeenCalledTimes(1)
  })

  it("defers on the daily limit and logs other gate refusals by code", async () => {
    for (const [code, event] of [
      ["daily_limit", "simplefin_sync_deferred"],
      ["unauthorized", "simplefin_sync_failed"],
    ] as const) {
      const { runtime, log, db } = setup({
        answer: () => Promise.reject(new SimpleFinError(code, "refused")),
      })
      await runtime.sync()
      expect(log.mock.calls).toEqual([[event, { reason: code }]])
      expect(runtime.messages()).toEqual([])
      expect(db.prepare("SELECT COUNT(*) AS n FROM cursors").get()).toEqual({
        n: 0,
      })
    }
  })

  it("does not read while the gate holds the connector open", async () => {
    const { runtime, getAccounts, log } = setup({
      health: [
        {
          name: "simplefin",
          health: "open",
          consecutiveFailures: 3,
          nextAttemptAt: "2026-03-02T00:00:00.000Z",
          lastError: "upstream_5xx",
        },
      ],
    })
    await runtime.sync()
    expect(getAccounts).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it("surfaces a local failure as a health message", async () => {
    const { runtime, db, log } = setup()
    db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON accounts
      BEGIN SELECT RAISE(ABORT, 'disk refused'); END`)
    await runtime.sync()
    expect(runtime.messages()).toEqual(["disk refused"])
    expect(log.mock.calls).toEqual([
      ["simplefin_sync_failed", { reason: "disk refused" }],
    ])
  })

  it("counts an account as assigned as soon as Settings stores its entity", async () => {
    const { runtime, db } = setup()
    await runtime.sync()
    expect(runtime.messages()).toEqual([
      "1 account needs an entity",
      "Lorem notice",
    ])
    await assignSimpleFinAccount(db, "acc_1", "ent_a")
    expect(runtime.messages()).toEqual(["Lorem notice"])
  })
})

describe("SimpleFIN backfill", () => {
  const spent: GateConnectorHealth["connectors"] = [
    {
      name: "simplefin",
      health: "degraded",
      consecutiveFailures: 0,
      requestsToday: 24,
      requestLimit: 24,
    },
  ]

  /** A runtime that has synced once with acc_1 unassigned, then had acc_1 assigned. */
  async function assignedAfterSync(
    options: Parameters<typeof setup>[0] = {}
  ): Promise<ReturnType<typeof setup>> {
    const ready = setup(options)
    await ready.runtime.syncNow()
    await assignSimpleFinAccount(ready.db, "acc_1", "ent_a")
    ready.log.mockClear()
    ready.getAccounts.mockClear()
    return ready
  }

  it("reads a newly assigned account's transactions and logs counts, never an id, name or balance", async () => {
    const { runtime, getAccounts, log, db } = await assignedAfterSync()
    await runtime.backfill()
    expect(getAccounts).toHaveBeenCalledTimes(1)
    expect(log.mock.calls).toEqual([
      [
        "simplefin_backfilled",
        { accounts: "1", transactions: "1", linked: "0", rejected: "0" },
      ],
    ])
    expect(pendingBackfillAccounts(db)).toEqual([])
    expect(
      db.prepare("SELECT entity_id FROM transactions").all()
    ).toEqual([{ entity_id: "ent_a" }])
  })

  it("logs no account id, name or balance from a sync or a backfill", async () => {
    const { runtime, log } = await assignedAfterSync()
    await runtime.backfill()
    await runtime.syncNow()
    const logged = JSON.stringify(log.mock.calls)
    expect(log.mock.calls.length).toBe(2)
    for (const secret of ["acc_1", "Lorem", "987"])
      expect(logged).not.toContain(secret)
  })

  it("runs after a scheduled sync even when no sync is due", async () => {
    const { runtime, getAccounts, db } = await assignedAfterSync()
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(1)
    expect(pendingBackfillAccounts(db)).toEqual([])
  })

  it("makes no request when nothing waits", async () => {
    const { runtime, getAccounts, log } = setup({ assigned: true })
    await runtime.backfill()
    expect(getAccounts).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it("waits for the next day while the budget is spent", async () => {
    const { runtime, getAccounts, log, db, setHealth } =
      await assignedAfterSync()
    setHealth(spent)
    await runtime.backfill()
    expect(getAccounts).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([
      ["simplefin_backfill_deferred", { reason: "daily_limit" }],
    ])
    expect(pendingBackfillAccounts(db)).toEqual(["acc_1"])
  })

  it("waits while the gate holds the connector open", async () => {
    const { runtime, getAccounts, log, db, setHealth } =
      await assignedAfterSync()
    setHealth([
      {
        name: "simplefin",
        health: "open",
        consecutiveFailures: 3,
        nextAttemptAt: "2026-03-02T00:00:00.000Z",
      },
    ])
    await runtime.backfill()
    expect(getAccounts).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([
      ["simplefin_backfill_deferred", { reason: "connector_unavailable" }],
    ])
    expect(pendingBackfillAccounts(db)).toEqual(["acc_1"])
  })

  it("waits when SimpleFIN reports the daily limit", async () => {
    const { runtime, log, db, setAnswer } = await assignedAfterSync()
    setAnswer(() => Promise.reject(new SimpleFinError("daily_limit", "limit")))
    await runtime.backfill()
    expect(log.mock.calls).toEqual([
      ["simplefin_backfill_deferred", { reason: "daily_limit" }],
    ])
    expect(pendingBackfillAccounts(db)).toEqual(["acc_1"])
  })

  it("logs a refused read by its code", async () => {
    const { runtime, log, db, setAnswer } = await assignedAfterSync()
    setAnswer(() =>
      Promise.reject(new SimpleFinError("unauthorized", "refused"))
    )
    await runtime.backfill()
    expect(log.mock.calls).toEqual([
      ["simplefin_backfill_failed", { reason: "unauthorized" }],
    ])
    expect(pendingBackfillAccounts(db)).toEqual(["acc_1"])
  })

  it("logs a local failure with any URL scrubbed", async () => {
    const { runtime, log, setAnswer } = await assignedAfterSync()
    setAnswer(() =>
      Promise.reject(new Error("socket closed at https://user:pw@example.invalid/x"))
    )
    await runtime.backfill()
    expect(log.mock.calls).toEqual([
      ["simplefin_backfill_failed", { reason: "socket closed at [url]" }],
    ])
  })

  it("shares one backfill between overlapping calls and settles before idle resolves", async () => {
    const { runtime, getAccounts, db } = await assignedAfterSync()
    void runtime.backfill()
    void runtime.backfill()
    await runtime.idle()
    expect(getAccounts).toHaveBeenCalledTimes(1)
    expect(pendingBackfillAccounts(db)).toEqual([])
  })
})

const local = (hour: number, minute: number, day = 1): number =>
  new Date(2026, 6, day, hour, minute).getTime()
const SIX_THIRTY: SyncTime = { hour: 6, minute: 30 }

describe("SimpleFIN runtime schedule", () => {
  it("syncs once a day at the configured local time", async () => {
    const { runtime, getAccounts, set } = setup({
      syncTime: SIX_THIRTY,
      startMs: local(7, 0),
    })
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(1)
    set(local(23, 0))
    await runtime.sync()
    set(local(6, 29, 2))
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(1)
    set(local(6, 30, 2))
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(2)
    set(local(18, 0, 2))
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(2)
  })

  it("does not repeat at the interval when a time is configured", async () => {
    const { runtime, getAccounts, advance } = setup({
      syncTime: SIX_THIRTY,
      startMs: local(7, 0),
    })
    await runtime.sync()
    advance(SIMPLEFIN_SYNC_INTERVAL_MS * 2)
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(1)
  })

  it("reports the next scheduled time, or now while a sync is due", async () => {
    const timed = setup({ syncTime: SIX_THIRTY, startMs: local(7, 0) })
    expect(timed.runtime.nextSyncAt()).toBe(new Date(local(7, 0)).toISOString())
    await timed.runtime.sync()
    expect(timed.runtime.nextSyncAt()).toBe(
      new Date(local(6, 30, 2)).toISOString()
    )
    const interval = setup()
    await interval.runtime.sync()
    expect(interval.runtime.nextSyncAt()).toBe(
      new Date(NOW_MS + SIMPLEFIN_SYNC_INTERVAL_MS).toISOString()
    )
  })
})

describe("SimpleFIN sync on request", () => {
  const spent: GateConnectorHealth["connectors"] = [
    {
      name: "simplefin",
      health: "degraded",
      consecutiveFailures: 0,
      lastError: "Daily limit",
      requestsToday: 24,
      requestLimit: 24,
    },
  ]

  it("runs once even when no sync is due, and reports the next scheduled one", async () => {
    const { runtime, getAccounts } = setup({
      syncTime: SIX_THIRTY,
      startMs: local(7, 0),
    })
    await runtime.sync()
    expect(await runtime.syncNow()).toEqual({
      status: "synced",
      nextSyncAt: new Date(local(6, 30, 2)).toISOString(),
    })
    expect(getAccounts).toHaveBeenCalledTimes(2)
  })

  it("shares one run between overlapping requests", async () => {
    const { runtime, getAccounts } = setup()
    const [first, second] = await Promise.all([
      runtime.syncNow(),
      runtime.syncNow(),
    ])
    expect(getAccounts).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
  })

  it("is refused with the daily-limit reason once the budget is spent, without a request", async () => {
    const { runtime, getAccounts, log } = setup({
      health: spent,
      startMs: local(14, 0),
    })
    expect(await runtime.syncNow()).toEqual({
      status: "refused",
      reason: "daily_limit",
      nextSyncAt: new Date(local(0, 0, 2)).toISOString(),
    })
    expect(getAccounts).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([
      ["simplefin_sync_deferred", { reason: "daily_limit" }],
    ])
  })

  it("is refused with the daily-limit reason when the gate refuses the read", async () => {
    const { runtime } = setup({
      startMs: local(14, 0),
      answer: () =>
        Promise.reject(new SimpleFinError("daily_limit", "refused")),
    })
    expect(await runtime.syncNow()).toEqual({
      status: "refused",
      reason: "daily_limit",
      nextSyncAt: new Date(local(0, 0, 2)).toISOString(),
    })
  })

  it("is refused while the gate holds the connector open", async () => {
    const { runtime, getAccounts } = setup({
      health: [
        {
          name: "simplefin",
          health: "open",
          consecutiveFailures: 3,
          nextAttemptAt: "2026-03-02T00:00:00.000Z",
        },
      ],
    })
    expect(await runtime.syncNow()).toEqual({
      status: "refused",
      reason: "connector_unavailable",
    })
    expect(getAccounts).not.toHaveBeenCalled()
  })

  it("reports a failed read as refused with sync_failed", async () => {
    const { runtime } = setup({
      answer: () =>
        Promise.reject(new SimpleFinError("unauthorized", "refused")),
    })
    expect(await runtime.syncNow()).toEqual({
      status: "refused",
      reason: "sync_failed",
    })
  })

  it("counts against the schedule: a scheduled run right after has nothing to do", async () => {
    const { runtime, getAccounts } = setup()
    await runtime.syncNow()
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(1)
  })
})

describe("withSimpleFinStatus", () => {
  const rows: GateConnectorHealth["connectors"] = [
    { name: "gmail", health: "healthy", consecutiveFailures: 0 },
    { name: "simplefin", health: "healthy", consecutiveFailures: 0 },
  ]
  const NEXT = "2026-03-01T06:30:00.000Z"
  const status = (messages: string[], next = NEXT) => ({
    messages: () => messages,
    nextSyncAt: () => next,
  })

  it("adds messages and the scheduled next sync to the SimpleFIN record only", async () => {
    const read = withSimpleFinStatus(
      () => Promise.resolve(rows),
      status(["1 account needs an entity"])
    )
    expect(await read()).toEqual([
      { name: "gmail", health: "healthy", consecutiveFailures: 0 },
      {
        name: "simplefin",
        health: "healthy",
        consecutiveFailures: 0,
        messages: ["1 account needs an entity"],
        nextSyncAt: NEXT,
      },
    ])
  })

  it("adds no messages field when there are none", async () => {
    const read = withSimpleFinStatus(() => Promise.resolve(rows), status([]))
    expect((await read())[1]).toEqual({
      name: "simplefin",
      health: "healthy",
      consecutiveFailures: 0,
      nextSyncAt: NEXT,
    })
  })

  it("keeps the gate's nextSyncAt when the daily budget is spent", async () => {
    const midnight = "2026-03-02T00:00:00.000Z"
    const read = withSimpleFinStatus(
      () =>
        Promise.resolve([
          {
            name: "simplefin",
            health: "degraded",
            consecutiveFailures: 0,
            nextSyncAt: midnight,
          },
        ]),
      status([])
    )
    expect((await read())[0]?.nextSyncAt).toBe(midnight)
  })

  it("adds no nextSyncAt while the connector is open", async () => {
    const read = withSimpleFinStatus(
      () =>
        Promise.resolve([
          { name: "simplefin", health: "open", consecutiveFailures: 3 },
        ]),
      status([])
    )
    expect((await read())[0]?.nextSyncAt).toBeUndefined()
  })
})
