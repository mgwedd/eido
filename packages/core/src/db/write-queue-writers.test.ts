import type { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { NOTHING_FOUND, harness } from "../extraction/extraction.test-support"
import type { Harness } from "../extraction/extraction.test-support"
import { createConversationStore } from "../conversation/store"
import { openConversationIndex } from "../conversation/search-index"
import { packIdFor, storeContextPack } from "../context/pack-store"
import type { ContextPack } from "../context/pack-store"
import { pruneSections, writeDigest, writeSection } from "../digest/cache"
import { createObligationStateStore } from "../ledger/obligation-state"
import {
  insertExtraction,
  insertLinks,
  insertObligation,
} from "../ledger/store"
import { addDocs, ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import { createWriteQueue, writeQueueFor } from "./write-queue"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await tick()
}

/**
 * Starts `open -> done` on an open obligation whose audit stays pending, so the connection sits
 * inside the obligation store's `BEGIN IMMEDIATE`. Then runs `write`, rejects the audit, and
 * checks the write was not applied while the transaction was open, is committed afterwards, and
 * the obligation change rolled back.
 */
async function writeDuringPendingAudit(
  db: DatabaseSync,
  docId: string,
  entityId: string,
  write: () => Promise<unknown>,
  written: () => boolean
): Promise<void> {
  const obligationId = insertObligation(db, {
    entityId,
    action: "Pay the invoice",
    status: "open",
    docId,
    span: { start: 0, end: 4 },
  })
  const calls: ((error: Error) => void)[] = []
  const obligations = createObligationStateStore(db, {
    audit: () =>
      new Promise<void>((_resolve, reject) => {
        calls.push(reject)
      }),
  })
  const change = obligations.change(obligationId, "done").then(
    () => "committed",
    (error: Error) => error.message
  )
  while (calls.length === 0) await tick()
  expect(db.isTransaction).toBe(true)

  const writing = write()
  await settle()
  expect(written()).toBe(false)

  calls[0]?.(new Error("gate down"))
  expect(await change).toBe("gate down")
  await writing
  expect(written()).toBe(true)
  expect(
    db.prepare("SELECT status FROM obligations WHERE id = ?").get(obligationId)
  ).toEqual({ status: "open" })
  expect(db.isTransaction).toBe(false)
}

const count = (db: DatabaseSync, sql: string): number =>
  Number(db.prepare(sql).get()?.["n"])

async function fixture() {
  const ledger = await ledgerFixture()
  cleanup.push(() => ledger.db.close())
  const [docId = ""] = addDocs(ledger.db, [
    testDoc("owed", { entityId: ledger.property.id }),
  ])
  return { ...ledger, docId }
}

describe("writers on the connection write queue", () => {
  it("conversation store: appendTurn", async () => {
    const { db, docId, property } = await fixture()
    const index = openConversationIndex(":memory:")
    cleanup.push(() => index.close())
    const store = createConversationStore({ db, index })
    await writeDuringPendingAudit(
      db,
      docId,
      property.id,
      () =>
        store.appendTurn("c1", {
          id: "t1",
          role: "user",
          text: "hello",
          at: "2030-01-01T00:00:00.000Z",
          sources: [],
        }),
      () => store.getTurns("c1").length === 1
    )
  })

  it("conversation store: putDigest", async () => {
    const { db, docId, property } = await fixture()
    const index = openConversationIndex(":memory:")
    cleanup.push(() => index.close())
    const store = createConversationStore({ db, index })
    await store.appendTurn("c1", {
      id: "t1",
      role: "user",
      text: "hello",
      at: "2030-01-01T00:00:00.000Z",
      sources: [],
    })
    await writeDuringPendingAudit(
      db,
      docId,
      property.id,
      () =>
        store.putDigest("c1", "digest", "parent", "2030-01-01T00:00:00.000Z", {
          summary: "s",
          coveredTurns: 1,
        }),
      () => store.getConversationDigest("c1") !== undefined
    )
  })

  it("conversation store: allocateSourceTag", async () => {
    const { db, docId, property } = await fixture()
    const index = openConversationIndex(":memory:")
    cleanup.push(() => index.close())
    const store = createConversationStore({ db, index })
    await store.appendTurn("c1", {
      id: "t1",
      role: "user",
      text: "hello",
      at: "2030-01-01T00:00:00.000Z",
      sources: [],
    })
    await writeDuringPendingAudit(
      db,
      docId,
      property.id,
      () => store.allocateSourceTag("c1", "ref-1"),
      () => store.resolveSourceTag("c1", "M1") === "ref-1"
    )
  })

  it("ledger store: insertExtraction", async () => {
    const { db, docId, property } = await fixture()
    await writeDuringPendingAudit(
      db,
      docId,
      property.id,
      () =>
        insertExtraction(db, {
          docId,
          schema: "extracted-fields",
          status: "processed_empty",
          model: "none",
          createdAt: "2030-01-01T00:00:00.000Z",
        }),
      () => count(db, "SELECT count(*) AS n FROM extractions") === 1
    )
  })

  it("ledger store: insertLinks", async () => {
    const { db, docId, property } = await fixture()
    await writeDuringPendingAudit(
      db,
      docId,
      property.id,
      () =>
        insertLinks(db, [
          {
            src: `doc:${docId}`,
            dst: `ent:${property.id}`,
            kind: "about_party",
            confidence: 0.5,
            origin: "match",
          },
        ]),
      () => count(db, "SELECT count(*) AS n FROM links") === 1
    )
  })

  it("extraction pipeline: the extraction_run savepoint", async () => {
    const h: Harness = await harness(
      [
        "Invoice INV-2041 from Example Supply Co.",
        "Payment of $4,800.00 is due by March 15, 2031.",
      ].join("\n"),
      [NOTHING_FOUND]
    )
    cleanup.push(() => h.close())
    cleanup.push(() => h.db.close())
    await writeDuringPendingAudit(
      h.db,
      h.docId,
      h.entityId,
      () => h.extractor.extractDocument(h.docId),
      () => count(h.db, "SELECT count(*) AS n FROM extractions") === 1
    )
  })

  it("digest cache: writeSection, writeDigest and pruneSections", async () => {
    const { db, docId, property } = await fixture()
    const section = {
      key: "s1",
      sourceFingerprint: "f",
      sectionIdentity: "i",
      promptVersion: "p",
      modelId: "m",
      lines: [{ text: "t", refs: ["r"] }],
      dropped: 0,
      createdAt: "2030-01-01T00:00:00.000Z",
    }
    await writeDuringPendingAudit(
      db,
      docId,
      property.id,
      () => writeSection(db, section),
      () => count(db, "SELECT count(*) AS n FROM digest_sections") === 1
    )
    await writeDuringPendingAudit(
      db,
      docId,
      property.id,
      () =>
        writeDigest(db, {
          key: "d1",
          kind: "document",
          subjectRef: "doc",
          promptVersion: "p",
          modelId: "m",
          fingerprint: "f",
          lines: [],
          coverage: {
            sections: 1,
            linesKept: 0,
            linesDropped: 0,
            splitSegments: 0,
          },
          createdAt: "2030-01-01T00:00:00.000Z",
        }),
      () => count(db, "SELECT count(*) AS n FROM digests") === 1
    )
    await writeDuringPendingAudit(
      db,
      docId,
      property.id,
      () => pruneSections(db, "9999-01-01T00:00:00.000Z"),
      () => count(db, "SELECT count(*) AS n FROM digest_sections") === 0
    )
  })

  it("context pack store: storeContextPack", async () => {
    const { db, docId, property } = await fixture()
    const hash = "ab".repeat(32)
    const pack: ContextPack = {
      id: packIdFor(hash),
      blocks: [],
      members: [],
      tokenCount: 1,
      droppedMembers: 0,
      packHash: hash,
    }
    await writeDuringPendingAudit(
      db,
      docId,
      property.id,
      () => storeContextPack(db, pack),
      () =>
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'context_packs'")
          .get() !== undefined &&
        count(db, "SELECT count(*) AS n FROM context_packs") === 1
    )
  })
})

describe("nested queued writes", () => {
  it("run inline inside a running job instead of deadlocking", async () => {
    const queue = createWriteQueue()
    const log: string[] = []
    const outer = queue.run(async () => {
      log.push("outer start")
      await tick()
      const inner = await queue.run(async () => {
        log.push("inner start")
        await tick()
        return queue.run(() => {
          log.push("innermost")
          return 3
        })
      })
      log.push("outer end")
      return inner
    })
    const next = queue.run(() => {
      log.push("next")
    })
    expect(await outer).toBe(3)
    await next
    expect(log).toEqual([
      "outer start",
      "inner start",
      "innermost",
      "outer end",
      "next",
    ])
  })

  it("passes a nested rejection to the job and keeps the queue usable", async () => {
    const queue = createWriteQueue()
    const outcome = await queue.run(async () => {
      try {
        await queue.run(() => {
          throw new Error("inner failed")
        })
        return "no error"
      } catch (error) {
        return error instanceof Error ? error.message : "unknown"
      }
    })
    expect(outcome).toBe("inner failed")
    expect(await queue.run(() => "still works")).toBe("still works")
  })

  it("an extraction run writes its extraction and ledger rows through nested savepoints", async () => {
    const h = await harness(
      [
        "Invoice INV-2041 from Example Supply Co.",
        "Payment of $4,800.00 is due by March 15, 2031.",
      ].join("\n"),
      [NOTHING_FOUND]
    )
    cleanup.push(() => h.close())
    cleanup.push(() => h.db.close())
    const result = await h.extractor.extractDocument(h.docId)
    expect(result.status).toBe("ok")
    expect(count(h.db, "SELECT count(*) AS n FROM extractions")).toBe(1)
    await writeQueueFor(h.db).drain()
    expect(h.db.isTransaction).toBe(false)
  })

  it("queued store calls run inline inside a job on the same connection", async () => {
    const { db, docId } = await fixture()
    await writeQueueFor(db).run(async () => {
      await insertExtraction(db, {
        docId,
        schema: "extracted-fields",
        status: "processed_empty",
        model: "none",
        createdAt: "2030-01-01T00:00:00.000Z",
      })
      await tick()
      await writeSection(db, {
        key: "s1",
        sourceFingerprint: "f",
        sectionIdentity: "i",
        promptVersion: "p",
        modelId: "m",
        lines: [{ text: "t", refs: ["r"] }],
        dropped: 0,
        createdAt: "2030-01-01T00:00:00.000Z",
      })
    })
    expect(count(db, "SELECT count(*) AS n FROM extractions")).toBe(1)
    expect(count(db, "SELECT count(*) AS n FROM digest_sections")).toBe(1)
  })
})
