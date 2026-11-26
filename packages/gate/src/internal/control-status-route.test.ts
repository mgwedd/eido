import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { validateGateControlStatus } from "@eido/schemas"
import {
  MemoryControlStore,
  attachControlCheckpoint,
} from "./control-checkpoint"
import type { ControlCheckpoint, RetrySchedule } from "./control-checkpoint"
import { openControlDb } from "./control-db"
import { NOT_FOUND } from "./http"
import type { GateRequest } from "./http"
import { controlHandler, dataPlaneHandler } from "./routes"
import type { GateState } from "./routes"
import { controlStatusRoute } from "./control-status-route"

// #916: the control checkpoint's enforced flag and deny reason on a route that reads no policy.

let dir: string
let dbPath: string
let store: MemoryControlStore
let handles: DatabaseSync[]
let guards: ControlCheckpoint[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-control-status-"))
  dbPath = join(dir, "eido-control.db")
  store = new MemoryControlStore()
  handles = []
  guards = []
})

afterEach(() => {
  for (const guard of guards) guard.close()
  for (const handle of handles) if (handle.isOpen) handle.close()
  rmSync(dir, { recursive: true, force: true })
})

function manualSchedule() {
  const pending: (() => void)[] = []
  const schedule: RetrySchedule = (run) => {
    pending.push(run)
    return () => undefined
  }
  return {
    schedule,
    fire: () => {
      const run = pending.shift()
      if (run === undefined) throw new Error("no retry is scheduled")
      run()
    },
  }
}

function start(schedule?: RetrySchedule): {
  db: DatabaseSync
  guard: ControlCheckpoint
} {
  const db = openControlDb(dbPath)
  handles.push(db)
  const guard = attachControlCheckpoint(db, {
    store,
    ...(schedule === undefined ? {} : { schedule }),
  })
  guards.push(guard)
  return { db, guard }
}

function stop(db: DatabaseSync, guard: ControlCheckpoint): void {
  guard.close()
  db.close()
}

function get(path: string): GateRequest {
  return {
    method: "GET",
    path,
    query: new URLSearchParams(),
    headers: {},
    body: () => Promise.resolve({ ok: true, text: "" }),
  }
}

/** A gate state whose policy read throws, as it does while the checkpoint is denied. */
function lockedState(db: DatabaseSync): GateState {
  return {
    db,
    get policy(): never {
      throw new Error("policy read while denied")
    },
  }
}

describe("controlStatusRoute", () => {
  it("reports an unenforced checkpoint as the flag alone", () => {
    const db = openControlDb(dbPath)
    handles.push(db)
    const reply = controlStatusRoute(db)
    expect(reply.status).toBe(200)
    expect(reply.body).toStrictEqual({ enforced: false })
    expect(validateGateControlStatus(reply.body).ok).toBe(true)
  })

  it("reports a verified checkpoint with no deny reason", () => {
    const { db } = start()
    const reply = controlStatusRoute(db)
    expect(reply.status).toBe(200)
    expect(reply.body).toStrictEqual({ enforced: true, denied: null })
    expect(validateGateControlStatus(reply.body).ok).toBe(true)
  })

  it("reports keychain_locked while the store is locked and none once the retry verifies", () => {
    const first = start()
    stop(first.db, first.guard)
    store.locked = true
    const timer = manualSchedule()
    const { db } = start(timer.schedule)

    const locked = controlStatusRoute(db)
    expect(locked.body).toStrictEqual({
      enforced: true,
      denied: "keychain_locked",
    })
    expect(validateGateControlStatus(locked.body).ok).toBe(true)

    // Still locked at the first retry: the reason stays.
    timer.fire()
    expect(controlStatusRoute(db).body).toStrictEqual({
      enforced: true,
      denied: "keychain_locked",
    })

    store.locked = false
    timer.fire()
    expect(controlStatusRoute(db).body).toStrictEqual({
      enforced: true,
      denied: null,
    })
  })

  it("reports a database that no longer matches the record by its reason alone", () => {
    const { db } = start()
    db.prepare(
      "INSERT INTO connectors (name, manifest_json, manifest_hash, pinned_at, enabled, health, consecutive_failures) VALUES (?, ?, ?, ?, 1, 'healthy', 0)"
    ).run("forged", "{}", "f".repeat(64), new Date().toISOString())
    const reply = controlStatusRoute(db)
    // Exact equality: any record, hash or keychain field added to the reply would fail it.
    expect(reply.body).toStrictEqual({
      enforced: true,
      denied: "control_state_mismatch",
    })
  })

  it("reports an unreadable store apart from a locked one", () => {
    store.failLoads = true
    const { db } = start()
    expect(controlStatusRoute(db).body).toStrictEqual({
      enforced: true,
      denied: "store_unreadable",
    })
  })
})

describe("GET /audit/control on the control handler", () => {
  it("answers while the checkpoint is denied without reading the policy", async () => {
    const first = start()
    stop(first.db, first.guard)
    store.locked = true
    const { db } = start(manualSchedule().schedule)
    const handler = controlHandler(
      () => lockedState(db),
      () => new Date()
    )
    const reply = await handler(get("/audit/control"))
    expect(reply.status).toBe(200)
    expect(reply.body).toStrictEqual({
      enforced: true,
      denied: "keychain_locked",
    })
  })

  it("serves only GET", async () => {
    const { db } = start()
    const handler = controlHandler(
      () => lockedState(db),
      () => new Date()
    )
    const reply = await handler({ ...get("/audit/control"), method: "POST" })
    expect(reply).toBe(NOT_FOUND)
  })
})

describe("GET /audit/control on the data plane", () => {
  it("is not served: the data plane never sees the checkpoint", async () => {
    const { db } = start()
    const handler = dataPlaneHandler(() => lockedState(db))
    expect(await handler(get("/audit/control"))).toBe(NOT_FOUND)
  })
})
