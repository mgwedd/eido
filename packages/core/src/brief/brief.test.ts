import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { writeDigest } from "../digest/cache"
import {
  coverageLine,
  generateBrief,
  getBrief,
  getLatestBrief,
  scheduleBrief,
} from "./index"
import type { BriefItemLine } from "./index"
import {
  CONFIG,
  NOW,
  fixture,
  markRead,
  putDoc,
  putObligation,
  unconfirmedAmount,
} from "./brief.test-support"
import type { Fixture } from "./brief.test-support"

const IN_WINDOW = "2026-11-02T05:00:00.000Z"
const BEFORE_WINDOW = "2026-10-20T05:00:00.000Z"

let f: Fixture
let db: DatabaseSync

beforeEach(async () => {
  f = await fixture()
  db = f.db
})

const items = (lines: { kind: string }[]): BriefItemLine[] =>
  lines.filter((line): line is BriefItemLine => line.kind !== "more")

/** One overdue, one due, one new undated obligation and one unconfirmed field. */
async function seedLedger(): Promise<void> {
  const old = putDoc(db, f.entityId, "old", BEFORE_WINDOW)
  const fresh = putDoc(db, f.entityId, "fresh", IN_WINDOW)
  const tax = putDoc(db, f.entityId, "tax", BEFORE_WINDOW)
  const invoice = putDoc(db, f.entityId, "invoice", BEFORE_WINDOW)
  await putObligation(db, f.entityId, old, {
    action: "Reply to the landlord",
    party: "Landlord Example",
    dueAt: "2026-10-30",
    span: { start: 4, end: 20, message_id: "m-old" },
  })
  await putObligation(db, f.entityId, tax, {
    action: "Pay the estimated tax",
    dueAt: "2026-11-15",
  })
  await putObligation(db, f.entityId, fresh, { action: "Book the dentist" })
  await unconfirmedAmount(db, invoice, 0.4)
}

describe("generateBrief lines", () => {
  test("orders overdue, due, changed, then needs-you, each with ledger and source", async () => {
    await seedLedger()
    const brief = await generateBrief(db, NOW, CONFIG)
    expect(brief.lines.map((line) => [line.kind, line.text])).toEqual([
      ["overdue", "Reply to the landlord (Landlord Example): 3 days overdue"],
      ["due", "Pay the estimated tax: due 2026-11-15"],
      ["changed", "New: Book the dentist"],
      ["needs-you", 'Confirm amount: "CHF 120.00"'],
    ])
    const [overdue, , , needsYou] = items(brief.lines)
    expect(overdue?.ledger.type).toBe("obligation")
    expect(overdue?.source).toMatchObject({
      messageId: "m-old",
      start: 4,
      end: 20,
    })
    expect(needsYou?.ledger.type).toBe("extraction")
    expect(needsYou?.source).toMatchObject({ page: 2, start: 30, end: 40 })
    for (const line of items(brief.lines)) {
      expect(line.ledger.id).not.toBe("")
      expect(line.source.docSha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test("ordering within a kind is by due date, then id", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    await putObligation(db, f.entityId, doc, {
      action: "B",
      dueAt: "2026-10-31",
    })
    await putObligation(db, f.entityId, doc, {
      action: "A",
      dueAt: "2026-10-29",
    })
    await putObligation(db, f.entityId, doc, {
      action: "C",
      dueAt: "2026-10-31",
    })
    const brief = await generateBrief(db, NOW, CONFIG)
    expect(brief.lines.map((line) => line.text.split(":")[0])).toEqual([
      "A",
      "B",
      "C",
    ])
  })

  test("leaves out done obligations, far-off due dates and old undated ones", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    await putObligation(db, f.entityId, doc, {
      action: "Done",
      dueAt: "2026-10-30",
      status: "done",
    })
    await putObligation(db, f.entityId, doc, {
      action: "Far",
      dueAt: "2027-03-01",
    })
    await putObligation(db, f.entityId, doc, { action: "Old undated" })
    expect((await generateBrief(db, NOW, CONFIG)).lines).toEqual([])
  })

  test("includes an obligation due today and one due on the last day of the horizon", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    await putObligation(db, f.entityId, doc, {
      action: "Today",
      dueAt: "2026-11-02",
    })
    await putObligation(db, f.entityId, doc, {
      action: "Edge",
      dueAt: "2026-11-16",
    })
    await putObligation(db, f.entityId, doc, {
      action: "Past edge",
      dueAt: "2026-11-17",
    })
    const brief = await generateBrief(db, NOW, CONFIG)
    expect(brief.lines.map((line) => line.text)).toEqual([
      "Today: due today",
      "Edge: due 2026-11-16",
    ])
  })

  test("a row without a usable source is excluded and counted, never shown", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    await putObligation(db, f.entityId, doc, {
      action: "Good",
      dueAt: "2026-10-30",
    })
    db.exec("PRAGMA ignore_check_constraints = ON")
    db.prepare(
      `INSERT INTO obligations (entity_id, action, due_at, status, doc_id, source_span)
       VALUES (?, 'Unsourced', '2026-10-31', 'open', ?, '{"start":5}')`
    ).run(f.entityId, doc)
    db.exec("PRAGMA ignore_check_constraints = OFF")
    const brief = await generateBrief(db, NOW, CONFIG)
    expect(brief.lines.map((line) => line.text)).toEqual([
      "Good: 3 days overdue",
    ])
    expect(brief.coverage.skipped).toBe(1)
  })

  test("an unconfirmed field with no usable span is skipped and counted", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    const id = Number(
      db
        .prepare(
          `INSERT INTO extractions (doc_id, schema, status, fields_json, model, created_at)
           VALUES (?, 'obligations', 'extracted', '{"amount":{"raw":"x"}}', 'm', 't')`
        )
        .run(doc).lastInsertRowid
    )
    db.prepare(
      "INSERT INTO extraction_field_confidence (extraction_id, field, confidence) VALUES (?, 'amount', 0.1)"
    ).run(id)
    const brief = await generateBrief(db, NOW, CONFIG)
    expect(brief.lines).toEqual([])
    expect(brief.coverage.skipped).toBe(1)
  })

  test("a confirmed or confident field is not listed as needs-you", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    await unconfirmedAmount(db, doc, 0.9)
    const confirmed = await unconfirmedAmount(db, doc, 0.4)
    db.prepare("UPDATE extractions SET confirmed_at = ? WHERE id = ?").run(
      "2026-11-01T00:00:00.000Z",
      confirmed
    )
    expect((await generateBrief(db, NOW, CONFIG)).lines).toEqual([])
  })
})

describe("generateBrief cap", () => {
  async function overdueItems(count: number): Promise<void> {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    for (let day = 1; day <= count; day++)
      await putObligation(db, f.entityId, doc, {
        action: `Item ${day}`,
        dueAt: `2026-10-${String(day).padStart(2, "0")}`,
      })
  }

  test("items beyond maxLines collapse into one linked 'more due soon' line", async () => {
    await overdueItems(5)
    const brief = await generateBrief(db, NOW, { ...CONFIG, maxLines: 3 })
    expect(brief.lines.map((line) => line.text)).toEqual([
      "Item 1: 32 days overdue",
      "Item 2: 31 days overdue",
      "3 more due soon",
    ])
    expect(brief.lines[2]).toMatchObject({
      kind: "more",
      count: 3,
      ledger: { type: "ledger" },
    })
  })

  test("exactly maxLines items are all shown", async () => {
    await overdueItems(3)
    const brief = await generateBrief(db, NOW, { ...CONFIG, maxLines: 3 })
    expect(brief.lines).toHaveLength(3)
    expect(brief.lines.some((line) => line.kind === "more")).toBe(false)
  })

  test("collapsing items that are not all due says only 'more'", async () => {
    await overdueItems(2)
    const doc = putDoc(db, f.entityId, "n", IN_WINDOW)
    await putObligation(db, f.entityId, doc, { action: "New one" })
    const brief = await generateBrief(db, NOW, { ...CONFIG, maxLines: 2 })
    expect(brief.lines.map((line) => line.text)).toEqual([
      "Item 1: 32 days overdue",
      "2 more",
    ])
  })
})

describe("generateBrief coverage", () => {
  test("counts come from queries over the window, and unprocessed documents show 'N of T'", async () => {
    const mailRead = putDoc(db, f.entityId, "m1", IN_WINDOW)
    putDoc(db, f.entityId, "m2", IN_WINDOW)
    const mailEmpty = putDoc(db, f.entityId, "m3", IN_WINDOW)
    const pdfRead = putDoc(db, f.entityId, "p1", IN_WINDOW, "application/pdf")
    putDoc(db, f.entityId, "p2", IN_WINDOW, "application/pdf")
    putDoc(db, f.entityId, "old", BEFORE_WINDOW)
    await markRead(db, mailRead)
    await markRead(db, mailEmpty)
    await markRead(db, pdfRead)
    const brief = await generateBrief(db, NOW, CONFIG)
    expect(brief.coverage).toMatchObject({
      messagesRead: 2,
      messagesTotal: 3,
      documentsRead: 1,
      documentsTotal: 2,
      windowStart: "2026-11-01T12:00:00.000Z",
      windowEnd: "2026-11-02T12:00:00.000Z",
    })
    expect(brief.coverageLine).toBe(
      "Nothing new or due. Read 2 of 3 new messages and 1 of 2 documents."
    )
  })

  test("a document with an extraction counts once however many rows it has", async () => {
    const doc = putDoc(db, f.entityId, "m1", IN_WINDOW)
    await unconfirmedAmount(db, doc, 0.4)
    await unconfirmedAmount(db, doc, 0.4)
    const brief = await generateBrief(db, NOW, CONFIG)
    expect(brief.coverage.messagesRead).toBe(1)
    expect(brief.coverage.messagesTotal).toBe(1)
  })

  test("when everything was read the line says so since yesterday", async () => {
    await markRead(db, putDoc(db, f.entityId, "m1", IN_WINDOW))
    const doc = putDoc(db, f.entityId, "o", BEFORE_WINDOW)
    await putObligation(db, f.entityId, doc, {
      action: "X",
      dueAt: "2026-10-30",
    })
    const brief = await generateBrief(db, NOW, CONFIG)
    expect(brief.coverageLine).toBe(
      "Read 1 new message and 0 documents since yesterday"
    )
  })

  test("coverageLine wording for the empty and partial forms", () => {
    const base = {
      messagesRead: 0,
      messagesTotal: 0,
      documentsRead: 0,
      documentsTotal: 0,
      windowStart: "a",
      windowEnd: "b",
      skipped: 0,
    }
    expect(coverageLine(base, false)).toBe(
      "Nothing new or due. Read 0 new messages and 0 documents."
    )
    expect(
      coverageLine(
        {
          ...base,
          messagesRead: 212,
          messagesTotal: 212,
          documentsRead: 6,
          documentsTotal: 6,
        },
        true
      )
    ).toBe("Read 212 new messages and 6 documents since yesterday")
    expect(
      coverageLine(
        {
          ...base,
          messagesRead: 10,
          messagesTotal: 12,
          documentsRead: 6,
          documentsTotal: 6,
        },
        true
      )
    ).toBe("Read 10 of 12 new messages and 6 of 6 documents")
  })
})

describe("generateBrief storage", () => {
  test("an empty ledger stores a brief with no lines and the coverage line", async () => {
    const brief = await generateBrief(db, NOW, CONFIG)
    expect(brief.lines).toEqual([])
    expect(brief.coverageLine).toBe(
      "Nothing new or due. Read 0 new messages and 0 documents."
    )
    expect(getBrief(db, "2026-11-02")).toEqual(brief)
  })

  test("a second run on the same local date returns the stored brief and writes one row", async () => {
    await seedLedger()
    const first = await generateBrief(db, NOW, CONFIG)
    const doc = putDoc(db, f.entityId, "late", "2026-11-02T13:00:00.000Z")
    await putObligation(db, f.entityId, doc, {
      action: "Late arrival",
      dueAt: "2026-10-01",
    })
    const second = await generateBrief(
      db,
      new Date("2026-11-02T15:00:00.000Z"),
      CONFIG
    )
    expect(second).toEqual(first)
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefs").get()?.["n"]).toBe(1)
  })

  test("concurrent runs for one date store one row", async () => {
    await Promise.all([
      generateBrief(db, NOW, CONFIG),
      generateBrief(db, NOW, CONFIG),
    ])
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefs").get()?.["n"]).toBe(1)
  })

  test("the window starts 24 hours back on the first run and at the previous window end after", async () => {
    const first = await generateBrief(db, NOW, CONFIG)
    expect(first.windowStart).toBe("2026-11-01T12:00:00.000Z")
    const next = new Date("2026-11-03T08:00:00.000Z")
    const second = await generateBrief(db, next, CONFIG)
    expect(second.forDate).toBe("2026-11-03")
    expect(second.windowStart).toBe("2026-11-02T12:00:00.000Z")
    expect(second.windowEnd).toBe("2026-11-03T08:00:00.000Z")
  })

  test("a document ingested between two briefs is covered by exactly one window", async () => {
    await generateBrief(db, NOW, CONFIG)
    putDoc(db, f.entityId, "between", "2026-11-02T20:00:00.000Z")
    const second = await generateBrief(
      db,
      new Date("2026-11-03T08:00:00.000Z"),
      CONFIG
    )
    expect(second.coverage.messagesTotal).toBe(1)
    const third = await generateBrief(
      db,
      new Date("2026-11-04T08:00:00.000Z"),
      CONFIG
    )
    expect(third.coverage.messagesTotal).toBe(0)
  })

  test("the date is the local one, not the UTC one", async () => {
    const lateEvening = new Date("2026-11-02T23:30:00.000Z")
    expect((await generateBrief(db, lateEvening, CONFIG)).forDate).toBe(
      "2026-11-03"
    )
  })

  test("getLatestBrief returns the newest date and undefined when none exists", async () => {
    expect(getLatestBrief(db)).toBeUndefined()
    expect(getBrief(db, "2026-11-02")).toBeUndefined()
    await generateBrief(db, NOW, CONFIG)
    await generateBrief(db, new Date("2026-11-03T08:00:00.000Z"), CONFIG)
    expect(getLatestBrief(db)?.forDate).toBe("2026-11-03")
  })

  test("a stored row that no longer parses is reported, not shown", async () => {
    await generateBrief(db, NOW, CONFIG)
    db.prepare('UPDATE briefs SET lines_json = \'[{"text":"x"}]\'').run()
    expect(() => getBrief(db, "2026-11-02")).toThrow("malformed")
    db.prepare(
      "UPDATE briefs SET lines_json = '[]', coverage_json = '{}'"
    ).run()
    expect(() => getBrief(db, "2026-11-02")).toThrow("malformed")
    db.prepare(
      `UPDATE briefs SET coverage_json = '{"windowStart":"a","windowEnd":"b","messagesRead":"1"}'`
    ).run()
    expect(() => getBrief(db, "2026-11-02")).toThrow("malformed")
  })

  test("refuses a configuration that cannot work", async () => {
    await expect(
      generateBrief(db, NOW, { ...CONFIG, maxLines: 0 })
    ).rejects.toThrow(RangeError)
    await expect(
      generateBrief(db, NOW, { ...CONFIG, dueWithinDays: -1 })
    ).rejects.toThrow(RangeError)
    await expect(
      generateBrief(db, NOW, { ...CONFIG, confirmThreshold: 2 })
    ).rejects.toThrow(RangeError)
    await expect(
      generateBrief(db, NOW, { ...CONFIG, time: "7am" })
    ).rejects.toThrow(RangeError)
    await expect(
      generateBrief(db, NOW, { ...CONFIG, timezone: "Mars/Base" })
    ).rejects.toThrow(RangeError)
  })
})

describe("generateBrief digest detail", () => {
  async function seedDigest(docId: string): Promise<void> {
    await writeDigest(db, {
      key: "k1",
      kind: "document",
      subjectRef: docId,
      promptVersion: "v1",
      modelId: "fake",
      fingerprint: docId,
      lines: [
        {
          text: "The notice opens a 30 day window.",
          cites: [
            {
              docSha256: docId,
              page: 1,
              injectionSuspected: false,
              reasons: [],
            },
          ],
        },
        {
          text: "Second line",
          cites: [{ messageId: "m", injectionSuspected: false, reasons: [] }],
        },
      ],
      coverage: {
        sections: 1,
        linesKept: 2,
        linesDropped: 0,
        splitSegments: 0,
      },
      createdAt: "2026-11-01T00:00:00.000Z",
    })
  }

  test("carries the first cached digest line with its cites", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    await putObligation(db, f.entityId, doc, {
      action: "Reply",
      dueAt: "2026-10-30",
    })
    await seedDigest(doc)
    const [line] = items((await generateBrief(db, NOW, CONFIG)).lines)
    expect(line?.detail).toEqual({
      text: "The notice opens a 30 day window.",
      cites: [
        { docSha256: doc, page: 1, injectionSuspected: false, reasons: [] },
      ],
    })
    expect(line?.text).toBe("Reply: 3 days overdue")
  })

  test("is omitted, not invented, when no digest is cached", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    await putObligation(db, f.entityId, doc, {
      action: "Reply",
      dueAt: "2026-10-30",
    })
    const [line] = items((await generateBrief(db, NOW, CONFIG)).lines)
    expect(line).toBeDefined()
    expect(line).not.toHaveProperty("detail")
  })

  test("falls back to the thread digest when the document has none", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    await putObligation(db, f.entityId, doc, {
      action: "Reply",
      dueAt: "2026-10-30",
      threadId: "thread-1",
    })
    await writeDigest(db, {
      key: "t1",
      kind: "thread",
      subjectRef: "thread-1",
      promptVersion: "v1",
      modelId: "fake",
      fingerprint: "f",
      lines: [
        {
          text: "Thread summary",
          cites: [{ messageId: "m1", injectionSuspected: false, reasons: [] }],
        },
      ],
      coverage: {
        sections: 1,
        linesKept: 1,
        linesDropped: 0,
        splitSegments: 0,
      },
      createdAt: "2026-11-01T00:00:00.000Z",
    })
    const [line] = items((await generateBrief(db, NOW, CONFIG)).lines)
    expect(line?.detail?.text).toBe("Thread summary")
  })
})

describe("scheduleBrief", () => {
  function harness(start: string) {
    let current = new Date(start)
    let tick: () => void = () => undefined
    let stopped = false
    const errors: unknown[] = []
    const scheduler = () =>
      scheduleBrief(db, () => CONFIG, {
        now: () => current,
        setTicker: (fn) => {
          tick = fn
          return () => {
            stopped = true
          }
        },
        onError: (error) => errors.push(error),
      })
    return {
      start: scheduler,
      advance: async (to: string, s: { whenIdle(): Promise<void> }) => {
        current = new Date(to)
        tick()
        await s.whenIdle()
      },
      errors,
      isStopped: () => stopped,
    }
  }
  const count = (): unknown =>
    db.prepare("SELECT COUNT(*) AS n FROM briefs").get()?.["n"]

  test("fires once the local clock passes the configured time and not before", async () => {
    // 05:30 in Zurich.
    const h = harness("2026-11-02T04:30:00.000Z")
    const s = h.start()
    await s.whenIdle()
    expect(count()).toBe(0)
    await h.advance("2026-11-02T05:59:00.000Z", s)
    expect(count()).toBe(0)
    await h.advance("2026-11-02T06:00:00.000Z", s)
    expect(getLatestBrief(db)).toMatchObject({
      forDate: "2026-11-02",
      generatedAt: "2026-11-02T06:00:00.000Z",
    })
    await h.advance("2026-11-02T09:00:00.000Z", s)
    expect(count()).toBe(1)
    await h.advance("2026-11-03T06:00:00.000Z", s)
    expect(count()).toBe(2)
    s.stop()
    expect(h.isStopped()).toBe(true)
  })

  test("catches up at startup when today's brief is missing", async () => {
    const h = harness("2026-11-02T10:00:00.000Z")
    const s = h.start()
    await s.whenIdle()
    expect(getLatestBrief(db)?.forDate).toBe("2026-11-02")
    s.stop()
  })

  test("does not generate at startup when today's brief exists", async () => {
    const stored = await generateBrief(db, NOW, CONFIG)
    const h = harness("2026-11-02T16:00:00.000Z")
    const s = h.start()
    await s.whenIdle()
    expect(getLatestBrief(db)).toEqual(stored)
    s.stop()
  })

  test("reports a failing run and keeps ticking", async () => {
    const errors: unknown[] = []
    let tick: () => void = () => undefined
    let calls = 0
    const s = scheduleBrief(
      db,
      () => {
        calls += 1
        return { ...CONFIG, timezone: "Mars/Base" }
      },
      {
        now: () => NOW,
        setTicker: (fn) => ((tick = fn), () => undefined),
        onError: (e) => errors.push(e),
      }
    )
    await s.whenIdle()
    tick()
    await s.whenIdle()
    expect(calls).toBe(2)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toBeInstanceOf(RangeError)
  })

  test("a tick during a run in flight is dropped", async () => {
    let tick: () => void = () => undefined
    let calls = 0
    let release: () => void = () => undefined
    const s = scheduleBrief(
      db,
      () => {
        calls += 1
        return new Promise((resolve) => {
          release = () => resolve(CONFIG)
        })
      },
      { now: () => NOW, setTicker: (fn) => ((tick = fn), () => undefined) }
    )
    tick()
    expect(calls).toBe(1)
    release()
    await s.whenIdle()
    expect(getLatestBrief(db)?.forDate).toBe("2026-11-02")
  })

  test("uses the real clock and timer by default", async () => {
    const s = scheduleBrief(db, () => ({ ...CONFIG, time: "23:59" }))
    await s.whenIdle()
    s.stop()
    expect(typeof s.stop).toBe("function")
  })
})

describe("generateBrief changed lines (#481)", () => {
  const setUpdatedAt = (id: number, at: string): void => {
    db.prepare("UPDATE obligations SET updated_at = ? WHERE id = ?").run(at, id)
  }

  test("an obligation whose change time is in the window is listed as updated", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    const id = await putObligation(db, f.entityId, doc, { action: "Call back" })
    setUpdatedAt(id, IN_WINDOW)
    const lines = (await generateBrief(db, NOW, CONFIG)).lines
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["changed", "Updated: Call back"],
    ])
  })

  test("a source ingested in the window does not make an unchanged obligation changed", async () => {
    const doc = putDoc(db, f.entityId, "d", IN_WINDOW)
    const id = await putObligation(db, f.entityId, doc, { action: "Call back" })
    setUpdatedAt(id, BEFORE_WINDOW)
    expect((await generateBrief(db, NOW, CONFIG)).lines).toEqual([])
  })

  test("a change time outside the window is not listed", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    const id = await putObligation(db, f.entityId, doc, { action: "Call back" })
    setUpdatedAt(id, "2026-11-02T12:00:00.001Z")
    expect((await generateBrief(db, NOW, CONFIG)).lines).toEqual([])
  })

  test("a reopened obligation shows up as changed", async () => {
    const doc = putDoc(db, f.entityId, "d", BEFORE_WINDOW)
    const id = await putObligation(db, f.entityId, doc, {
      action: "Call back",
      status: "done",
    })
    db.prepare(
      "UPDATE obligations SET status = 'open', updated_at = ? WHERE id = ?"
    ).run(IN_WINDOW, id)
    expect((await generateBrief(db, NOW, CONFIG)).lines).toHaveLength(1)
  })
})
