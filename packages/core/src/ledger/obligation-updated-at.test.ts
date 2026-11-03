import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { insertObligation } from "./index"
import { ledgerFixture, sha } from "./ledger.test-support"

let db: DatabaseSync
let id: number
let ingestedAt: string

const updatedAt = (): string =>
  String(
    db.prepare("SELECT updated_at FROM obligations WHERE id = ?").get(id)?.[
      "updated_at"
    ]
  )

/** Runs a write and returns the change time it left, plus the clock bounds around it. */
function write(
  sql: string,
  ...args: (string | number)[]
): {
  before: string
  after: string
  stored: string
} {
  const before = new Date().toISOString()
  db.prepare(sql).run(...args)
  const after = new Date().toISOString()
  return { before, after, stored: updatedAt() }
}

beforeEach(async () => {
  const fixture = await ledgerFixture()
  db = fixture.db
  const doc = sha("a")
  ingestedAt = "2026-01-01T00:00:00.000Z"
  db.prepare(
    `INSERT INTO documents (sha256, source, source_ref, mime, entity_id, ingested_at)
     VALUES (?, 'gmail', 'ref-a', 'message/rfc822', ?, ?)`
  ).run(doc, fixture.property.id, ingestedAt)
  id = await insertObligation(db, {
    entityId: fixture.property.id,
    action: "Pay the invoice",
    dueAt: "2026-12-01",
    status: "open",
    docId: doc,
    span: { start: 0, end: 5 },
  })
})

describe("obligation change time (#481)", () => {
  test("a new obligation is stamped with its source document's ingest time", () => {
    expect(updatedAt()).toBe(ingestedAt)
  })

  test("a status change sets the change time to now", () => {
    const { before, after, stored } = write(
      "UPDATE obligations SET status = 'done' WHERE id = ?",
      id
    )
    expect(stored >= before && stored <= after).toBe(true)
    expect(stored).not.toBe(ingestedAt)
  })

  test("a due date change sets the change time to now", () => {
    const { before, after, stored } = write(
      "UPDATE obligations SET due_at = '2026-12-15' WHERE id = ?",
      id
    )
    expect(stored >= before && stored <= after).toBe(true)
  })

  test("a due date cleared to none is a change", () => {
    const { stored } = write(
      "UPDATE obligations SET due_at = NULL WHERE id = ?",
      id
    )
    expect(stored).not.toBe(ingestedAt)
  })

  test("a write that sets the same status and due date leaves the change time", () => {
    write(
      "UPDATE obligations SET status = 'open', due_at = '2026-12-01' WHERE id = ?",
      id
    )
    expect(updatedAt()).toBe(ingestedAt)
  })

  test("a write to other columns leaves the change time", () => {
    write("UPDATE obligations SET party = 'Landlord Example' WHERE id = ?", id)
    expect(updatedAt()).toBe(ingestedAt)
  })

  test("a writer that sets the change time itself is not overridden", () => {
    write(
      "UPDATE obligations SET status = 'done', updated_at = '2026-02-02T00:00:00.000Z' WHERE id = ?",
      id
    )
    expect(updatedAt()).toBe("2026-02-02T00:00:00.000Z")
  })
})
