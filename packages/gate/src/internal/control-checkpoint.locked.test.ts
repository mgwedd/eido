import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Intent } from "@eido/schemas"
import { issueNonce, verifyApproval } from "./approvals"
import type { ApprovalRequest } from "./approvals"
import {
  getPinnedManifest,
  pinManifest,
  prepareManifestPin,
} from "./connectors"
import type {
  ControlAuthorization,
  PreparedControlApproval,
} from "./control-approvals"
import {
  ControlStateError,
  LOCKED_RETRY_FIRST_MS,
  LOCKED_RETRY_MAX_MS,
  MemoryControlStore,
  attachControlCheckpoint,
  controlStatus,
  controlTransaction,
  inspectControlCheckpoint,
  lockedRetryDelay,
} from "./control-checkpoint"
import type { ControlCheckpoint, RetrySchedule } from "./control-checkpoint"
import { openControlDb } from "./control-db"
import { beginRegistration, registerCredential } from "./credentials"
import { createExecutor } from "./executor"
import type { UpstreamWriter, WriteRequest } from "./executor"
import { intentStatus, propose } from "./intents"
import { loadPolicy } from "./policy"
import {
  MAIL_OPS,
  OWNER,
  WEBAUTHN,
  assertion,
  deviceChallenge,
  manifest,
  registration,
  sample,
  testAuthenticator,
} from "./test-fixtures"
import type { TestAuthenticator } from "./test-fixtures"

// #822: a keychain that is locked when the gate starts, or locks later, denies every authority
// read as `keychain_locked` and is loaded again on a back-off timer. Only a store that reports
// itself locked is retried; every other failure keeps its denial until supervised recovery.

let dir: string
let dbPath: string
let store: MemoryControlStore
let handles: DatabaseSync[]
let guards: ControlCheckpoint[]
let signCount: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-checkpoint-locked-"))
  dbPath = join(dir, "eido-control.db")
  store = new MemoryControlStore()
  handles = []
  guards = []
  signCount = 0
})

afterEach(() => {
  vi.useRealTimers()
  for (const guard of guards) guard.close()
  for (const handle of handles) if (handle.isOpen) handle.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A schedule that records each request and runs it only when the test says so. */
function manualSchedule() {
  const pending: { run: () => void; delayMs: number; cancelled: boolean }[] = []
  const schedule: RetrySchedule = (run, delayMs) => {
    const entry = { run, delayMs, cancelled: false }
    pending.push(entry)
    return () => {
      entry.cancelled = true
    }
  }
  return {
    schedule,
    pending,
    delays: () => pending.map((entry) => entry.delayMs),
    /** Fires the newest request, as its timer would. */
    fire: () => {
      const entry = pending.at(-1)
      if (entry === undefined) throw new Error("no retry is scheduled")
      entry.run()
    },
  }
}

function start(
  options: {
    schedule?: RetrySchedule
    onChange?: (denied: string | undefined) => void
  } = {}
): { db: DatabaseSync; guard: ControlCheckpoint } {
  const db = openControlDb(dbPath)
  handles.push(db)
  const guard = attachControlCheckpoint(db, { store, ...options })
  guards.push(guard)
  return { db, guard }
}

function stop(db: DatabaseSync, guard: ControlCheckpoint): void {
  guard.close()
  db.close()
}

function enrol(db: DatabaseSync, owner: TestAuthenticator): void {
  const begun = beginRegistration(db, "admin")
  if (!begun.ok) throw new Error("enrolment challenge refused")
  const result = registerCredential(
    db,
    WEBAUTHN,
    "admin",
    registration(owner, begun.challenge)
  )
  if (!result.ok) throw new Error(`enrolment refused: ${result.code}`)
}

function sign(
  owner: TestAuthenticator,
  prepared: PreparedControlApproval
): ControlAuthorization & { assertion: ReturnType<typeof assertion> } {
  const challenge = createHash("sha256")
    .update(
      JSON.stringify([
        "eido.control.v1",
        prepared.purpose,
        prepared.target,
        prepared.id,
        prepared.payloadHash,
        prepared.nonce,
      ])
    )
    .digest("base64url")
  signCount += 1
  const signed = assertion(owner, challenge, { signCount })
  return {
    config: WEBAUTHN,
    request: { id: prepared.id, nonce: prepared.nonce, assertion: signed },
    assertion: signed,
  }
}

const LABEL_URL = "https://mail.example.com/v1/labels"

/** The mail connector with a pinned route for labels, as the executor needs it. */
function mailConnector() {
  const mail = manifest("mail", MAIL_OPS)
  const labels = mail.operations.find((op) => op.intentKind === "email.label")
  if (labels === undefined) throw new Error("missing labels operation")
  labels.routes = [
    { host: "mail.example.com", method: "POST", pathPattern: "/v1/labels" },
  ]
  return mail
}

function pin(db: DatabaseSync, owner: TestAuthenticator): void {
  const mail = mailConnector()
  pinManifest(db, mail, "owner", sign(owner, prepareManifestPin(db, mail)))
}

/** An installation with an enrolled owner and a pinned connector, then stopped. */
function established(): TestAuthenticator {
  const owner = testAuthenticator()
  const first = start()
  enrol(first.db, owner)
  pin(first.db, owner)
  stop(first.db, first.guard)
  return owner
}

function denial(work: () => unknown): string | undefined {
  try {
    work()
  } catch (error) {
    return error instanceof ControlStateError ? error.reason : "other-error"
  }
  return undefined
}

describe("a keychain locked at gate start", () => {
  it("denies authority reads as keychain_locked, then allows them after a retry, in one gate lifetime", () => {
    established()
    store.locked = true
    const timer = manualSchedule()
    const changes: (string | undefined)[] = []
    const { db, guard } = start({
      schedule: timer.schedule,
      onChange: (denied) => changes.push(denied),
    })
    expect(guard.denied()).toBe("keychain_locked")
    expect(denial(() => getPinnedManifest(db, "mail"))).toBe("keychain_locked")
    expect(controlStatus(db)).toEqual({
      enforced: true,
      denied: "keychain_locked",
    })

    // Still locked at the first retry: nothing changes and the next retry is queued.
    timer.fire()
    expect(guard.denied()).toBe("keychain_locked")
    expect(changes).toEqual([])
    expect(timer.pending).toHaveLength(2)

    store.locked = false
    timer.fire()
    expect(guard.denied()).toBeUndefined()
    expect(getPinnedManifest(db, "mail")?.name).toBe("mail")
    expect(changes).toEqual([undefined])
    // Verified: no further retry is queued.
    expect(timer.pending).toHaveLength(2)
  })

  it("does not leave the locked state on a load that comes back mismatched", () => {
    established()
    store.locked = true
    const timer = manualSchedule()
    const changes: (string | undefined)[] = []
    const { db, guard } = start({
      schedule: timer.schedule,
      onChange: (denied) => changes.push(denied),
    })
    db.exec("UPDATE connectors SET manifest_hash = 'forged'")
    store.locked = false
    timer.fire()
    expect(guard.denied()).toBe("control_state_mismatch")
    expect(denial(() => getPinnedManifest(db, "mail"))).toBe(
      "control_state_mismatch"
    )
    expect(changes).toEqual(["control_state_mismatch"])
    // A mismatch is not a lock: it is never retried.
    expect(timer.pending).toHaveLength(1)
  })

  it("stops retrying when the unlocked store turns out unreadable", () => {
    established()
    store.locked = true
    const timer = manualSchedule()
    const { guard } = start({ schedule: timer.schedule })
    store.locked = false
    store.failLoads = true
    timer.fire()
    expect(guard.denied()).toBe("store_unreadable")
    expect(timer.pending).toHaveLength(1)
  })

  it("reports keychain_locked from inspection", () => {
    established()
    store.locked = true
    const { db } = start({ schedule: manualSchedule().schedule })
    expect(inspectControlCheckpoint(db, store)).toEqual({
      state: "denied",
      reason: "keychain_locked",
    })
  })
})

describe("an unreadable store", () => {
  it("is denied as store_unreadable and never retried as a lock", () => {
    established()
    store.failLoads = true
    const timer = manualSchedule()
    const { db, guard } = start({ schedule: timer.schedule })
    expect(guard.denied()).toBe("store_unreadable")
    expect(denial(() => getPinnedManifest(db, "mail"))).toBe("store_unreadable")
    expect(timer.pending).toEqual([])
    // Even once the store reads again, this gate stays denied.
    store.failLoads = false
    expect(guard.denied()).toBe("store_unreadable")
  })

  it("does not retry an uninitialised store", () => {
    established()
    store.value = undefined
    const timer = manualSchedule()
    const { guard } = start({ schedule: timer.schedule })
    expect(guard.denied()).toBe("uninitialized")
    expect(timer.pending).toEqual([])
  })
})

describe("a keychain that locks after start", () => {
  it("denies the change as keychain_locked and recovers through the retry", () => {
    const owner = established()
    const timer = manualSchedule()
    const changes: (string | undefined)[] = []
    const { db, guard } = start({
      schedule: timer.schedule,
      onChange: (denied) => changes.push(denied),
    })
    expect(guard.denied()).toBeUndefined()
    store.locked = true
    expect(denial(() => controlTransaction(db, "roster", () => 1))).toBe(
      "keychain_locked"
    )
    expect(guard.denied()).toBe("keychain_locked")
    expect(denial(() => getPinnedManifest(db, "mail"))).toBe("keychain_locked")
    expect(changes).toEqual(["keychain_locked"])
    expect(timer.delays()).toEqual([LOCKED_RETRY_FIRST_MS])

    store.locked = false
    timer.fire()
    expect(guard.denied()).toBeUndefined()
    expect(changes).toEqual(["keychain_locked", undefined])
    // A signed change works again after recovery.
    const things = manifest("things", MAIL_OPS)
    pinManifest(
      db,
      things,
      "owner",
      sign(owner, prepareManifestPin(db, things))
    )
    expect(getPinnedManifest(db, "things")?.name).toBe("things")
  })

  it("keeps an unreadable store at a change as store_unreadable, with no retry", () => {
    established()
    const timer = manualSchedule()
    const { db, guard } = start({ schedule: timer.schedule })
    store.failLoads = true
    expect(denial(() => controlTransaction(db, "roster", () => 1))).toBe(
      "store_unreadable"
    )
    expect(guard.denied()).toBe("store_unreadable")
    expect(timer.pending).toEqual([])
  })
})

describe("retry back-off", () => {
  it("starts at 5 s, doubles, and caps at 5 min", () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => lockedRetryDelay(attempt))
    ).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
    ])
    expect(LOCKED_RETRY_MAX_MS).toBe(300_000)
  })

  it("schedules each retry with the next delay while the store stays locked", () => {
    established()
    store.locked = true
    const timer = manualSchedule()
    start({ schedule: timer.schedule })
    for (let i = 0; i < 7; i++) timer.fire()
    expect(timer.delays()).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ])
  })

  it("starts again from 5 s after a recovery and a later lock", () => {
    established()
    store.locked = true
    const timer = manualSchedule()
    const { db } = start({ schedule: timer.schedule })
    timer.fire()
    store.locked = false
    timer.fire()
    store.locked = true
    denial(() => controlTransaction(db, "roster", () => 1))
    expect(timer.delays()).toEqual([5_000, 10_000, 5_000])
  })

  it("cancels the pending retry on shutdown, and a late run does nothing", () => {
    established()
    store.locked = true
    const timer = manualSchedule()
    const { db, guard } = start({ schedule: timer.schedule })
    guard.close()
    expect(timer.pending.map((entry) => entry.cancelled)).toEqual([true])
    store.locked = false
    timer.fire()
    expect(guard.denied()).toBe("keychain_locked")
    expect(timer.pending).toHaveLength(1)
    db.close()
  })

  it("uses an unref'd timer by default and clears it on shutdown", () => {
    vi.useFakeTimers()
    established()
    store.locked = true
    const { guard } = start()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(LOCKED_RETRY_FIRST_MS - 1)
    expect(guard.denied()).toBe("keychain_locked")
    store.locked = false
    vi.advanceTimersByTime(1)
    expect(guard.denied()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    store.locked = true
    denial(() => controlTransaction(guardDb(), "roster", () => 1))
    expect(vi.getTimerCount()).toBe(1)
    guard.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("never holds the process open while a retry waits", () => {
    const unref = vi.fn()
    const set = vi
      .spyOn(globalThis, "setTimeout")
      // @ts-expect-error a stand-in timer: only unref is called on it
      .mockReturnValue({ unref })
    established()
    store.locked = true
    start()
    expect(set).toHaveBeenCalledWith(
      expect.any(Function),
      LOCKED_RETRY_FIRST_MS
    )
    expect(unref).toHaveBeenCalledOnce()
    set.mockRestore()
  })
})

function guardDb(): DatabaseSync {
  const db = handles.at(-1)
  if (db === undefined) throw new Error("no database is open")
  return db
}

describe("no external write while locked", () => {
  function labelWriter(): UpstreamWriter {
    return {
      kind: "email.label",
      connector: "mail",
      buildRequest(intent) {
        if (intent.kind !== "email.label") throw new Error("wrong kind")
        return {
          method: "POST",
          url: LABEL_URL,
          body: { provider_arguments: intent.args },
        }
      },
      intentFromRequest(request, connector) {
        if (
          request.url !== LABEL_URL ||
          request.body === null ||
          typeof request.body !== "object" ||
          !("provider_arguments" in request.body)
        )
          throw new Error("wrong provider route")
        return {
          kind: "email.label",
          ...(connector === undefined ? {} : { connector }),
          args: request.body.provider_arguments,
        }
      },
      inverse: (intent) => intent,
    }
  }

  function policyFor(db: DatabaseSync) {
    return loadPolicy(db, {
      dataDir: dir,
      ownerAddresses: [OWNER],
      allowedRoots: ["notes"],
      storedAttendees: () => ({ ok: false }),
    }).policy
  }

  function proposed(db: DatabaseSync, intent: Intent): string {
    const result = propose(db, policyFor(db), { intent, origin: "reactive" })
    if (!result.ok) throw new Error(result.code)
    return result.intentId
  }

  it("does not approve a signed approval or execute a ready write until the retry verifies", async () => {
    const owner = established()
    const first = start()
    const label = proposed(first.db, {
      kind: "email.label",
      connector: "mail",
      args: { messageIds: ["msg-1"], add: ["work"] },
    })
    const send = proposed(first.db, sample("email.send"))
    expect(intentStatus(first.db, label)?.state).toBe("approved")
    expect(intentStatus(first.db, send)?.state).toBe("pending")
    const prepared = issueNonce(first.db, send)
    if (!prepared.ok) throw new Error(prepared.code)
    const request: ApprovalRequest = {
      intentId: send,
      nonce: prepared.nonce,
      assertion: assertion(
        owner,
        deviceChallenge(prepared.payloadHash, send, prepared.nonce),
        { signCount: ++signCount }
      ),
    }
    stop(first.db, first.guard)

    store.locked = true
    const timer = manualSchedule()
    const { db, guard } = start({ schedule: timer.schedule })
    expect(guard.denied()).toBe("keychain_locked")
    const sent: string[] = []
    const transport = vi.fn((request: WriteRequest) => {
      sent.push(request.url)
      return Promise.resolve({ upstreamRef: "provider-ref-1", result: {} })
    })
    const executor = createExecutor(db, [labelWriter()], transport)

    expect(denial(() => verifyApproval(db, WEBAUTHN, request))).toBe(
      "keychain_locked"
    )
    expect(intentStatus(db, send)?.state).toBe("pending")
    // The pinned route cannot be read while locked, so the executor refuses before any request.
    await expect(executor.execute(label)).resolves.toEqual({
      ok: false,
      code: "connector_unavailable",
    })
    expect(transport).not.toHaveBeenCalled()
    expect(intentStatus(db, label)?.state).toBe("approved")

    store.locked = false
    timer.fire()
    expect(guard.denied()).toBeUndefined()
    expect(verifyApproval(db, WEBAUTHN, request).ok).toBe(true)
    expect(intentStatus(db, send)?.state).toBe("approved")
    await expect(executor.execute(label)).resolves.toMatchObject({ ok: true })
    expect(sent).toEqual([LABEL_URL])
  })
})
