import { afterEach, describe, expect, it } from "vitest"
import { openDataDb } from "../ledger/db"
import { createObligationStateStore } from "../ledger/obligation-state"
import { insertObligation } from "../ledger/store"
import { addDocs, ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import { createDriveClient } from "../connectors/drive/client"
import { fakeDrive } from "../connectors/drive/fake-drive.test-support"
import { syncDrive } from "../connectors/drive/sync"
import { createProfileStore } from "../profile/store"
import { createWriteQueue, writeQueueFor } from "./write-queue"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** An audit sink whose calls stay pending until the test settles them, oldest first. */
function pendingAudit() {
  const calls: { resolve: () => void; reject: (error: Error) => void }[] = []
  return {
    calls,
    sink: () =>
      new Promise<void>((resolve, reject) => {
        calls.push({ resolve, reject })
      }),
    async waitForCall(index: number): Promise<void> {
      while (calls[index] === undefined) await tick()
    },
  }
}

describe("write queue", () => {
  it("runs work one at a time in call order and survives a rejection", async () => {
    const queue = createWriteQueue()
    const log: string[] = []
    let release: () => void = () => {}
    const first = queue.run(async () => {
      log.push("first start")
      await new Promise<void>((resolve) => {
        release = resolve
      })
      log.push("first end")
    })
    const second = queue.run(() => {
      log.push("second")
      throw new Error("boom")
    })
    const third = queue.run(() => {
      log.push("third")
      return 3
    })
    await tick()
    expect(log).toEqual(["first start"])
    release()
    await first
    await expect(second).rejects.toThrow("boom")
    expect(await third).toBe(3)
    expect(log).toEqual(["first start", "first end", "second", "third"])
    await queue.drain()
  })

  it("gives one connection one queue", () => {
    const a = openDataDb(":memory:")
    const b = openDataDb(":memory:")
    cleanup.push(
      () => a.close(),
      () => b.close()
    )
    expect(writeQueueFor(a)).toBe(writeQueueFor(a))
    expect(writeQueueFor(a)).not.toBe(writeQueueFor(b))
  })

  it("keeps a sync ingest committed when a pending obligation audit is rejected", async () => {
    const fake = await fakeDrive()
    cleanup.push(fake.close)
    const { db, profile, property } = await ledgerFixture()
    cleanup.push(() => db.close())
    await profile.assignAccount({
      connector: "drive",
      accountRef: "owner@example.invalid",
      entityId: property.id,
    })
    const [docId = ""] = addDocs(db, [
      testDoc("owed", { entityId: property.id }),
    ])
    const obligationId = insertObligation(db, {
      entityId: property.id,
      action: "Pay the invoice",
      status: "open",
      docId,
      span: { start: 0, end: 4 },
    })
    const audit = pendingAudit()
    const obligations = createObligationStateStore(db, { audit: audit.sink })
    fake.files.set("one", {
      id: "one",
      name: "First",
      mimeType: "text/plain",
      text: "First body",
    })

    const change = obligations.change(obligationId, "done")
    const changeOutcome = change.then(
      () => "committed",
      (error: Error) => error.message
    )
    await audit.waitForCall(0)
    expect(db.isTransaction).toBe(true)

    const sync = syncDrive({
      db,
      client: createDriveClient(fake.transport),
      account: { accountRef: "owner@example.invalid", entities: profile },
    })
    // The sync waits for the open transaction instead of running inside it.
    for (let i = 0; i < 20; i++) await tick()
    expect(
      db.prepare("SELECT 1 FROM documents WHERE source = 'drive'").all()
    ).toEqual([])

    audit.calls[0]?.reject(new Error("gate down"))
    expect(await changeOutcome).toBe("gate down")
    await sync

    expect(
      db
        .prepare("SELECT source_ref FROM documents WHERE source = 'drive'")
        .all()
        .map((row) => row["source_ref"])
    ).toEqual(["one"])
    expect(
      db
        .prepare("SELECT status FROM obligations WHERE id = ?")
        .get(obligationId)
    ).toEqual({ status: "open" })
    expect(db.isTransaction).toBe(false)
  })

  it("lets profile and obligation changes issued together both succeed in order", async () => {
    const { db, property } = await ledgerFixture()
    cleanup.push(() => db.close())
    const [docId = ""] = addDocs(db, [
      testDoc("owed", { entityId: property.id }),
    ])
    const obligationId = insertObligation(db, {
      entityId: property.id,
      action: "Pay the invoice",
      status: "open",
      docId,
      span: { start: 0, end: 4 },
    })
    const order: string[] = []
    const profileAudit = pendingAudit()
    const obligationAudit = pendingAudit()
    const profile = createProfileStore(db, {
      audit: (entry) => {
        order.push(`profile ${entry.action}`)
        return profileAudit.sink()
      },
    })
    const obligations = createObligationStateStore(db, {
      audit: (entry) => {
        order.push(entry.action)
        return obligationAudit.sink()
      },
    })

    const created = profile.createEntity({
      kind: "company",
      name: "Another Company",
      tag: "ANOTHER",
    })
    const changed = obligations.change(obligationId, "done")
    await profileAudit.waitForCall(0)
    for (let i = 0; i < 20; i++) await tick()
    // The obligation change waits behind the profile change's pending audit.
    expect(obligationAudit.calls).toHaveLength(0)

    profileAudit.calls[0]?.resolve()
    await obligationAudit.waitForCall(0)
    obligationAudit.calls[0]?.resolve()

    expect((await created).tag).toBe("ANOTHER")
    expect(await changed).toEqual({ id: obligationId, status: "done" })
    expect(order).toEqual(["profile entity.create", "obligation.done"])
    expect(db.isTransaction).toBe(false)
  })
})
