import { afterEach, describe, expect, it } from "vitest"
import type { ConnectorManifest } from "@eido/schemas"
import { openControlDb } from "./control-db"
import {
  beginConnectorRead,
  disableConnectorAfterAuthFailure,
  getConnectorHealth,
  recordConnectorReadFailure,
  recordConnectorReadSuccess,
  releaseConnectorProbe,
} from "./connector-health"
import { MAIL_OPS, manifest, signedPin } from "./test-fixtures"

const databases: ReturnType<typeof openControlDb>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function setup(jitter = false): ReturnType<typeof openControlDb> {
  const db = openControlDb(":memory:")
  databases.push(db)
  const mail: ConnectorManifest = {
    ...manifest("mail", MAIL_OPS),
    health: {
      backoff: { baseMs: 10, maxMs: 30, jitter },
      breaker: { failureThreshold: 3, halfOpenProbeAfterMs: 20 },
    },
  }
  signedPin(db, mail)
  return db
}

function failRead(
  db: ReturnType<typeof openControlDb>,
  at: number,
  attempt = beginConnectorRead(db, "mail", at)
): void {
  recordConnectorReadFailure(db, "mail", "handshake_failed", attempt, at)
}

describe("gate-owned connector health", () => {
  it("backs off while degraded, opens at the threshold, and admits one due probe", () => {
    const db = setup()
    failRead(db, 1_000)
    expect(getConnectorHealth(db)[0]).toMatchObject({
      health: "degraded",
      consecutiveFailures: 1,
      nextAttemptAt: new Date(1_010).toISOString(),
    })
    expect(beginConnectorRead(db, "mail", 1_009)).toMatchObject({
      allowed: false,
      reason: "connector_backoff",
    })
    failRead(db, 1_010)
    expect(getConnectorHealth(db)[0]).toMatchObject({
      health: "degraded",
      consecutiveFailures: 2,
      nextAttemptAt: new Date(1_030).toISOString(),
    })
    expect(beginConnectorRead(db, "mail", 1_029).allowed).toBe(false)
    failRead(db, 1_030)
    expect(getConnectorHealth(db)[0]).toMatchObject({
      health: "open",
      consecutiveFailures: 3,
      nextAttemptAt: new Date(1_060).toISOString(),
    })
    expect(beginConnectorRead(db, "mail", 1_059).allowed).toBe(false)
    const probe = beginConnectorRead(db, "mail", 1_060)
    expect(probe).toMatchObject({ allowed: true, probe: true })
    expect(beginConnectorRead(db, "mail", 1_060).allowed).toBe(false)
    recordConnectorReadSuccess(db, "mail", probe)
    expect(getConnectorHealth(db)[0]).toMatchObject({
      health: "healthy",
      consecutiveFailures: 0,
    })
  })

  it("reopens after a failed probe with a longer capped delay", () => {
    const db = setup()
    failRead(db, 1_000)
    failRead(db, 1_010)
    failRead(db, 1_030)
    const probe = beginConnectorRead(db, "mail", 1_060)
    recordConnectorReadFailure(db, "mail", "timeout", probe, 1_060)
    expect(getConnectorHealth(db)[0]).toMatchObject({
      health: "open",
      consecutiveFailures: 4,
      lastError: "timeout",
      nextAttemptAt: new Date(1_090).toISOString(),
    })
  })

  it("keeps jitter bounded by the exponential cap", () => {
    const db = setup(true)
    const attempt = beginConnectorRead(db, "mail", 4_000)
    recordConnectorReadFailure(
      db,
      "mail",
      "handshake_failed",
      attempt,
      4_000,
      () => 0.5
    )
    expect(getConnectorHealth(db)[0]?.nextAttemptAt).toBe(
      new Date(4_005).toISOString()
    )
  })

  it("rolls back a failed atomic probe reservation", () => {
    const db = setup()
    db.prepare(
      `UPDATE connectors SET health = 'open', consecutive_failures = 3,
       next_attempt_at = ?, last_error = 'handshake_failed' WHERE name = 'mail'`
    ).run(new Date(5_000).toISOString())
    db.exec(`CREATE TRIGGER fail_probe_reservation
      BEFORE UPDATE OF probe_started_at ON connectors
      BEGIN SELECT RAISE(ABORT, 'probe reservation failed'); END;`)

    expect(() => beginConnectorRead(db, "mail", 5_000)).toThrow(
      "probe reservation failed"
    )
    expect(getConnectorHealth(db)[0]?.health).toBe("open")
    db.prepare("DROP TRIGGER fail_probe_reservation").run()
    expect(beginConnectorRead(db, "mail", 5_000).probe).toBe(true)
  })

  it("does not let an expired probe close or release its replacement lease", () => {
    const db = setup()
    db.prepare(
      `UPDATE connectors SET health = 'open', consecutive_failures = 3,
       next_attempt_at = ?, last_error = 'handshake_failed' WHERE name = 'mail'`
    ).run(new Date(5_000).toISOString())
    const first = beginConnectorRead(db, "mail", 5_000)
    const second = beginConnectorRead(db, "mail", 65_001)
    expect(second.probeLeaseId).not.toBe(first.probeLeaseId)

    recordConnectorReadSuccess(db, "mail", first)
    recordConnectorReadFailure(db, "mail", "timeout", first, 65_001)
    releaseConnectorProbe(db, "mail", first)
    expect(getConnectorHealth(db)[0]?.health).toBe("open")
    expect(beginConnectorRead(db, "mail", 65_002).allowed).toBe(false)

    recordConnectorReadSuccess(db, "mail", second)
    expect(getConnectorHealth(db)[0]).toMatchObject({
      health: "healthy",
      consecutiveFailures: 0,
    })
  })

  it("disables auth failures without counting them as retryable failures", () => {
    const db = setup()
    disableConnectorAfterAuthFailure(db, "mail")
    expect(
      db.prepare("SELECT enabled FROM connectors WHERE name = 'mail'").get()?.[
        "enabled"
      ]
    ).toBe(0)
    expect(getConnectorHealth(db)[0]).toMatchObject({
      health: "open",
      consecutiveFailures: 0,
      lastError: "auth_failed",
    })
  })
})
