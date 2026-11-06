import { afterEach, describe, expect, it, vi } from "vitest"
import { BridgeError } from "./bridge/errors"
import { payloadHash } from "./canonical"
import { bridgeProbe } from "./connector-connect"
import type { ConnectorProbe, ProbeOutcome } from "./connector-connect"
import { getConnectorHealth } from "./connector-health"
import type { GateRequest } from "./http"
import { controlHandler, dataPlaneHandler } from "./routes"
import { applyFirstPin, prepareFirstPin } from "./repin"
import {
  auditRows,
  controlAuthorization,
  MAIL_OPS,
  manifest,
  setup,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

const NOW = new Date("2026-11-02T09:00:00.000Z")

function post(path: string): GateRequest {
  return {
    method: "POST",
    path,
    query: new URLSearchParams(),
    headers: {},
    body: () => Promise.resolve({ ok: true, text: "" }),
  }
}

let s: Setup | undefined
afterEach(() => {
  s?.cleanup()
  s = undefined
})

function gate(): Setup {
  s = setup([manifest("gmail", MAIL_OPS), manifest("proton-mail", MAIL_OPS)])
  return s
}

async function connected(
  setUp: Setup,
  name: string,
  probes: Record<string, ConnectorProbe>
) {
  return controlHandler(
    () => ({ db: setUp.db, policy: setUp.policy, probes }),
    () => NOW
  )(post(`/connectors/${name}/connected`))
}

const always =
  (outcome: ProbeOutcome): ConnectorProbe =>
  () =>
    Promise.resolve(outcome)

function row(setUp: Setup, name: string) {
  return setUp.db
    .prepare(
      "SELECT enabled, health, consecutive_failures, last_error, next_attempt_at, probe_lease_id FROM connectors WHERE name = ?"
    )
    .get(name)
}

function setRow(setUp: Setup, name: string, sql: string): void {
  setUp.db.prepare(`UPDATE connectors SET ${sql} WHERE name = ?`).run(name)
}

describe("POST /connectors/{name}/connected", () => {
  it("connects gmail on a fresh gate once its first pin is signed (#627)", async () => {
    s = setup([])
    const setUp = s
    const gmail = manifest("gmail", MAIL_OPS)
    const unpinned = await connected(setUp, "gmail", { gmail: always("ok") })
    expect(unpinned.status).toBe(404)

    const prepared = prepareFirstPin(setUp.db, "gmail", gmail)
    if (!prepared.ok)
      throw new Error(`first pin not prepared: ${prepared.code}`)
    const authorization = controlAuthorization(setUp.db, prepared.prepared)
    expect(applyFirstPin(setUp.db, "gmail", gmail, authorization).ok).toBe(true)

    const reply = await connected(setUp, "gmail", { gmail: always("ok") })
    expect(reply).toEqual({
      status: 200,
      body: {
        connectors: [
          { name: "gmail", health: "healthy", consecutiveFailures: 0 },
        ],
      },
    })
    expect(
      auditRows(setUp.db)
        .filter((r) => r.target === "gmail")
        .map((r) => r.action)
    ).toEqual(["connector.pinned", "connector.connected"])
  })

  it("probes a connector and reports it healthy", async () => {
    const setUp = gate()
    const probe = vi.fn(always("ok"))
    const reply = await connected(setUp, "gmail", { gmail: probe })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(reply).toEqual({
      status: 200,
      body: {
        connectors: [
          { name: "gmail", health: "healthy", consecutiveFailures: 0 },
        ],
      },
    })
  })

  it("re-enables a connector whose credential was refused, once the new one works", async () => {
    const setUp = gate()
    setRow(
      setUp,
      "gmail",
      "enabled = 0, health = 'open', last_error = 'auth_failed', consecutive_failures = 4"
    )
    const reply = await connected(setUp, "gmail", { gmail: always("ok") })
    expect(reply.status).toBe(200)
    expect(row(setUp, "gmail")).toMatchObject({
      enabled: 1,
      health: "healthy",
      consecutive_failures: 0,
      last_error: null,
    })
    expect(auditRows(setUp.db).at(-1)).toMatchObject({
      actor: "admin",
      action: "connector.connected",
      target: "gmail",
      detail_hash: payloadHash({ outcome: "ok", reenabled: true }),
    })
  })

  it("lifts the backoff of a degraded connector and checks it now", async () => {
    const setUp = gate()
    setRow(
      setUp,
      "gmail",
      "health = 'degraded', consecutive_failures = 1, last_error = 'timeout', next_attempt_at = '2026-11-02T10:00:00.000Z'"
    )
    await connected(setUp, "gmail", { gmail: always("ok") })
    expect(row(setUp, "gmail")).toMatchObject({
      health: "healthy",
      next_attempt_at: null,
    })
  })

  it("probes an open connector even while its half-open wait and an old lease stand", async () => {
    const setUp = gate()
    setRow(
      setUp,
      "gmail",
      `health = 'open', consecutive_failures = 3, last_error = 'unavailable',
       next_attempt_at = '2026-11-02T10:00:00.000Z',
       probe_started_at = '2026-11-02T08:59:59.000Z', probe_lease_id = 'old-lease'`
    )
    await connected(setUp, "gmail", { gmail: always("ok") })
    expect(row(setUp, "gmail")).toMatchObject({
      health: "healthy",
      probe_lease_id: null,
    })
  })

  it("disables the connector again when the new credential is refused", async () => {
    const setUp = gate()
    const reply = await connected(setUp, "proton-mail", {
      "proton-mail": always("auth_failed"),
    })
    expect(reply).toEqual({
      status: 200,
      body: {
        connectors: [
          {
            name: "proton-mail",
            health: "open",
            consecutiveFailures: 0,
            lastError: "auth_failed",
          },
        ],
      },
    })
    expect(row(setUp, "proton-mail")?.["enabled"]).toBe(0)
    expect(auditRows(setUp.db).at(-1)).toMatchObject({
      action: "connector.connected",
      detail_hash: payloadHash({ outcome: "auth_failed", reenabled: false }),
    })
  })

  it("records an unreachable upstream as a health failure with backoff", async () => {
    const setUp = gate()
    await connected(setUp, "gmail", { gmail: always("handshake_failed") })
    expect(row(setUp, "gmail")).toMatchObject({
      enabled: 1,
      health: "degraded",
      consecutive_failures: 1,
      last_error: "handshake_failed",
    })
  })

  it("treats a probe that throws as unavailable", async () => {
    const setUp = gate()
    await connected(setUp, "gmail", {
      gmail: () => Promise.reject(new Error("boom")),
    })
    expect(row(setUp, "gmail")).toMatchObject({
      health: "degraded",
      last_error: "unavailable",
    })
  })

  it("keeps a connector disabled for manifest drift disabled", async () => {
    const setUp = gate()
    setRow(
      setUp,
      "gmail",
      `enabled = 0, health = 'open', last_error = 'auth_failed', drift_json = '{"added":["x"],"removed":[]}'`
    )
    const probe = vi.fn(always("ok"))
    const reply = await connected(setUp, "gmail", { gmail: probe })
    expect(reply).toMatchObject({ status: 403, body: { code: "forbidden" } })
    expect(probe).not.toHaveBeenCalled()
    expect(row(setUp, "gmail")?.["enabled"]).toBe(0)
  })

  it("keeps a connector disabled for a missing signed pin disabled", async () => {
    const setUp = gate()
    setRow(setUp, "gmail", "enabled = 0")
    const reply = await connected(setUp, "gmail", { gmail: always("ok") })
    expect(reply).toMatchObject({ status: 403, body: { code: "forbidden" } })
  })

  it("refuses a connector that is not pinned", async () => {
    const setUp = gate()
    const reply = await connected(setUp, "drive", { drive: always("ok") })
    expect(reply).toMatchObject({ status: 404, body: { code: "not_found" } })
  })

  it("refuses a connector the gate has no probe for, and changes nothing", async () => {
    const setUp = gate()
    setRow(setUp, "gmail", "enabled = 0, last_error = 'auth_failed'")
    const before = auditRows(setUp.db).length
    const reply = await connected(setUp, "gmail", {})
    expect(reply).toMatchObject({ status: 503, body: { code: "unavailable" } })
    expect(row(setUp, "gmail")?.["enabled"]).toBe(0)
    expect(auditRows(setUp.db)).toHaveLength(before)
  })

  it("is not served on the data plane", async () => {
    const setUp = gate()
    const reply = await dataPlaneHandler(() => ({
      db: setUp.db,
      policy: setUp.policy,
      probes: { gmail: always("ok") },
    }))(post("/connectors/gmail/connected"))
    expect(reply.status).toBe(404)
    expect(getConnectorHealth(setUp.db)[0]?.health).toBe("healthy")
    expect(
      auditRows(setUp.db).some(
        (entry) => entry.action === "connector.connected"
      )
    ).toBe(false)
  })
})

describe("bridgeProbe", () => {
  const failing = (error: Error) =>
    bridgeProbe({ listFolders: () => Promise.reject(error) })

  it("is ok when Bridge lists the folders", async () => {
    expect(
      await bridgeProbe({ listFolders: () => Promise.resolve(["INBOX"]) })()
    ).toBe("ok")
  })

  it("passes Bridge's auth and handshake failures through", async () => {
    expect(await failing(new BridgeError("auth_failed", "no"))()).toBe(
      "auth_failed"
    )
    expect(await failing(new BridgeError("handshake_failed", "no"))()).toBe(
      "handshake_failed"
    )
  })

  it("reports anything else as unavailable", async () => {
    expect(await failing(new BridgeError("bridge_error", "no"))()).toBe(
      "unavailable"
    )
    expect(await failing(new Error("socket"))()).toBe("unavailable")
  })
})
