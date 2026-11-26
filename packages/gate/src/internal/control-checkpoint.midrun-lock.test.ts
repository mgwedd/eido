import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { verifyChain } from "./audit"
import {
  ControlStateError,
  LOCKED_RETRY_FIRST_MS,
  MemoryControlStore,
  attachControlCheckpoint,
  controlStatus,
  controlTransaction,
  reportKeychainLocked,
  requireControlState,
} from "./control-checkpoint"
import type { ControlCheckpoint, RetrySchedule } from "./control-checkpoint"
import { openControlDb } from "./control-db"

// #878: a vault read that finds the keychain locked moves a verified checkpoint into
// keychain_locked and starts the back-off retry, with no control change. Each move into or out
// of keychain_locked appends one audit row carrying the reason only.

let dir: string
let store: MemoryControlStore
let handles: { db: DatabaseSync; guard: ControlCheckpoint }[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-checkpoint-midrun-"))
  store = new MemoryControlStore()
  handles = []
})

afterEach(() => {
  for (const { db, guard } of handles) {
    guard.close()
    if (db.isOpen) db.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

function manualSchedule() {
  const pending: { run: () => void; delayMs: number }[] = []
  const schedule: RetrySchedule = (run, delayMs) => {
    pending.push({ run, delayMs })
    return () => undefined
  }
  return {
    schedule,
    delays: () => pending.map((entry) => entry.delayMs),
    fire: () => {
      const entry = pending.at(-1)
      if (entry === undefined) throw new Error("no retry is scheduled")
      entry.run()
    },
  }
}

function start(schedule: RetrySchedule) {
  const db = openControlDb(join(dir, "eido-control.db"))
  const changes: (string | undefined)[] = []
  const guard = attachControlCheckpoint(db, {
    store,
    schedule,
    onChange: (denied) => changes.push(denied),
  })
  handles.push({ db, guard })
  return { db, guard, changes }
}

function denial(work: () => unknown): string | undefined {
  try {
    work()
  } catch (error) {
    return error instanceof ControlStateError ? error.reason : "other-error"
  }
  return undefined
}

/** The lock audit rows, as action and detail hash. */
function lockRows(db: DatabaseSync): { action: string; detail: string }[] {
  return db
    .prepare(
      "SELECT action, detail_hash FROM audit_log WHERE action LIKE 'control.keychain%' ORDER BY seq"
    )
    .all()
    .map((row) => ({
      action: String(row["action"]),
      detail: String(row["detail_hash"]),
    }))
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex")
const LOCKED = sha256('{"reason":"keychain_locked"}')
const VERIFIED = sha256('{"reason":"verified"}')

describe("a vault read that finds the keychain locked", () => {
  it("moves a verified gate into keychain_locked and schedules the retry, with no control change", () => {
    const timer = manualSchedule()
    const { db, guard, changes } = start(timer.schedule)
    expect(guard.denied()).toBeUndefined()
    const recordBefore = store.value

    reportKeychainLocked(db)

    expect(guard.denied()).toBe("keychain_locked")
    expect(denial(() => requireControlState(db))).toBe("keychain_locked")
    expect(controlStatus(db)).toEqual({
      enforced: true,
      denied: "keychain_locked",
    })
    expect(changes).toEqual(["keychain_locked"])
    expect(timer.delays()).toEqual([LOCKED_RETRY_FIRST_MS])
    // Noticing the lock changes no control state.
    expect(store.value).toBe(recordBefore)

    timer.fire()
    expect(guard.denied()).toBeUndefined()
    expect(denial(() => requireControlState(db))).toBeUndefined()
    expect(changes).toEqual(["keychain_locked", undefined])
  })

  it("keeps any other denial, so a lock never makes a recovery-only denial retryable", () => {
    // An installation with a record, then a store that no longer parses.
    const first = start(manualSchedule().schedule)
    first.guard.close()
    first.db.close()
    store.value = "not a record"
    const timer = manualSchedule()
    const { db, guard, changes } = start(timer.schedule)
    expect(guard.denied()).toBe("store_malformed")

    reportKeychainLocked(db)

    expect(guard.denied()).toBe("store_malformed")
    expect(changes).toEqual([])
    expect(timer.delays()).toEqual([])
    expect(lockRows(db)).toEqual([])
  })

  it("does not queue a second retry when the gate is already locked", () => {
    const timer = manualSchedule()
    const { db, changes } = start(timer.schedule)
    reportKeychainLocked(db)
    reportKeychainLocked(db)
    expect(timer.delays()).toEqual([LOCKED_RETRY_FIRST_MS])
    expect(changes).toEqual(["keychain_locked"])
  })
})

describe("audit rows for keychain lock moves", () => {
  it("appends one row on entering and one on leaving; retries while locked append none", () => {
    const timer = manualSchedule()
    const { db } = start(timer.schedule)
    expect(lockRows(db)).toEqual([])

    store.locked = true
    reportKeychainLocked(db)
    reportKeychainLocked(db)
    timer.fire()
    timer.fire()
    expect(timer.delays()).toEqual([
      LOCKED_RETRY_FIRST_MS,
      LOCKED_RETRY_FIRST_MS * 2,
      LOCKED_RETRY_FIRST_MS * 4,
    ])
    expect(lockRows(db)).toEqual([
      { action: "control.keychain_locked", detail: LOCKED },
    ])

    store.locked = false
    timer.fire()
    expect(lockRows(db)).toEqual([
      { action: "control.keychain_locked", detail: LOCKED },
      { action: "control.keychain_lock_cleared", detail: VERIFIED },
    ])
    expect(verifyChain(db).ok).toBe(true)
  })

  it("records a start with the keychain locked, and a retry that ends in another denial", () => {
    const first = start(manualSchedule().schedule)
    first.guard.close()
    first.db.close()
    store.locked = true
    const timer = manualSchedule()
    const { db, guard } = start(timer.schedule)
    expect(lockRows(db)).toEqual([
      { action: "control.keychain_locked", detail: LOCKED },
    ])

    store.locked = false
    store.value = "not a record"
    timer.fire()
    expect(guard.denied()).toBe("store_malformed")
    expect(lockRows(db)).toEqual([
      { action: "control.keychain_locked", detail: LOCKED },
      {
        action: "control.keychain_lock_cleared",
        detail: sha256('{"reason":"store_malformed"}'),
      },
    ])
  })

  it("keeps the row of a lock found at a control change, which rolls back", () => {
    const timer = manualSchedule()
    const { db, guard, changes } = start(timer.schedule)
    store.locked = true
    expect(denial(() => controlTransaction(db, "roster", () => 1))).toBe(
      "keychain_locked"
    )
    expect(guard.denied()).toBe("keychain_locked")
    expect(changes).toEqual(["keychain_locked"])
    expect(timer.delays()).toEqual([LOCKED_RETRY_FIRST_MS])
    expect(lockRows(db)).toEqual([
      { action: "control.keychain_locked", detail: LOCKED },
    ])
  })

  it("appends no row for an unreadable store at a control change", () => {
    const timer = manualSchedule()
    const { db, guard } = start(timer.schedule)
    store.failLoads = true
    expect(denial(() => controlTransaction(db, "roster", () => 1))).toBe(
      "store_unreadable"
    )
    expect(guard.denied()).toBe("store_unreadable")
    expect(lockRows(db)).toEqual([])
  })
})
