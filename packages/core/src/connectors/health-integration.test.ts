import type { DatabaseSync } from "node:sqlite"
import type { GateConnectorHealth } from "@eido/schemas"
import { beforeEach, describe, expect, test } from "vitest"
import { getCursor } from "../index/index"
import { openDataDb } from "../ledger/db"
import { createProfileStore } from "../profile/store"
import { resolveGmailConfig } from "./gmail/config"
import { createGmailClient } from "./gmail/client"
import { createFakeGmail, seedInbox } from "./gmail/fake-gmail.test-support"
import { syncGmailWithHealth } from "./gmail/sync"
import { resolveConfig } from "./proton/config"
import { HandshakeFailedError } from "./proton/errors"
import { MemorySource, plainMessage } from "./proton/memory-source.test-support"
import { syncProton, syncProtonWithHealth } from "./proton/sync"
import type { ConnectorHealthReader } from "./health-aware-sync"

type HealthItem = GateConnectorHealth["connectors"][number]

describe("health-aware connector sync integration", () => {
  let db: DatabaseSync
  let proton: MemorySource
  let gmail: ReturnType<typeof createFakeGmail>
  let health: HealthItem[]
  let gate: ConnectorHealthReader

  beforeEach(async () => {
    db = openDataDb(":memory:")
    proton = new MemorySource()
    gmail = createFakeGmail()
    const profile = createProfileStore(db, { audit: () => Promise.resolve() })
    const entity = await profile.createEntity({
      kind: "personal",
      name: "Test Personal",
      tag: "ME",
    })
    await profile.assignAccount({
      connector: "proton",
      accountRef: "assistant@example.com",
      entityId: entity.id,
    })
    await profile.assignAccount({
      connector: "gmail",
      accountRef: "assistant@example.com",
      entityId: entity.id,
    })
    health = [
      { name: "proton-mail", health: "healthy", consecutiveFailures: 0 },
      { name: "gmail", health: "healthy", consecutiveFailures: 0 },
    ]
    gate = { getConnectorHealth: () => Promise.resolve(health) }
  })

  test("Proton failure leaves its cursor safe while Gmail syncs, then recovery resumes without duplicates", async () => {
    const entities = createProfileStore(db, { audit: () => Promise.resolve() })
    const protonConfig = resolveConfig({ username: "assistant@example.com" })
    const first = plainMessage("proton-one")
    const second = plainMessage("proton-two")
    proton.addFolder("INBOX", "7", [
      { uid: 1, raw: first },
      { uid: 2, raw: second },
    ])
    await syncProton(db, proton, protonConfig, entities)
    expect(getCursor(db, "proton", "INBOX")?.cursor).toBe("2")

    proton.addFolder("INBOX", "7", [
      { uid: 1, raw: first },
      { uid: 2, raw: second },
      { uid: 3, raw: plainMessage("proton-three") },
    ])
    proton.failAll = new HandshakeFailedError("synthetic Bridge outage")
    await expect(
      syncProtonWithHealth(gate, db, proton, protonConfig, entities)
    ).rejects.toBeInstanceOf(HandshakeFailedError)
    expect(getCursor(db, "proton", "INBOX")?.cursor).toBe("2")

    health = health.map((state) =>
      state.name === "proton-mail"
        ? {
            ...state,
            health: "open",
            consecutiveFailures: 3,
            nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
            lastError: "handshake_failed",
          }
        : state
    )
    seedInbox(gmail, 1)
    const gmailConfig = resolveGmailConfig({ batchSize: 1, fullSyncLimit: 10 })
    const gmailResult = await syncGmailWithHealth(
      gate,
      db,
      createGmailClient(gmail.transport),
      gmailConfig,
      { accountRef: "assistant@example.com", entities },
      {}
    )
    expect(gmailResult.status).toBe("synced")
    expect(gmail.requests.length).toBeGreaterThan(0)
    expect(getCursor(db, "gmail", "INBOX")).not.toBeNull()

    proton.failAll = undefined
    proton.addFolder("INBOX", "7", [
      { uid: 1, raw: first },
      { uid: 2, raw: second },
      { uid: 3, raw: plainMessage("proton-three") },
    ])
    health = health.map((state) =>
      state.name === "proton-mail"
        ? {
            ...state,
            nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
          }
        : state
    )
    const recovered = await syncProtonWithHealth(
      gate,
      db,
      proton,
      protonConfig,
      entities
    )
    expect(recovered.status).toBe("synced")
    if (recovered.status !== "synced") throw new Error("probe should have run")
    expect(recovered.result).toMatchObject([
      { folder: "INBOX", inserted: 1, resynced: false },
    ])
    expect(getCursor(db, "proton", "INBOX")?.cursor).toBe("3")
    expect(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM documents WHERE source = 'proton'"
          )
          .get()?.["n"]
      )
    ).toBe(3)
  })

  test("an open connector is skipped before its gate probe deadline", async () => {
    health = health.map((state) =>
      state.name === "proton-mail"
        ? {
            ...state,
            health: "open",
            consecutiveFailures: 3,
            nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
          }
        : state
    )
    const result = await syncProtonWithHealth(
      gate,
      db,
      proton,
      resolveConfig({ username: "assistant@example.com" }),
      createProfileStore(db, { audit: () => Promise.resolve() })
    )
    expect(result).toEqual({ status: "skipped" })
    expect(proton.calls).toEqual([])
  })
})
