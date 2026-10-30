import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { ingestBatch } from "../index/ingest"
import { listObligations } from "../ledger/store"
import { ledgerFixture, sha } from "../ledger/ledger.test-support"
import type { LedgerFixture } from "../ledger/ledger.test-support"
import { openDataDb } from "../ledger/db"
import { detectReplies, syncReplyObligations } from "./replies"
import type { RepliesConfig } from "./replies"

let fixture: LedgerFixture
let cfg: RepliesConfig
const own = "owner@example.com"
const other = "partner@example.com"
const at = (day: number): string =>
  new Date(Date.UTC(2026, 0, day)).toISOString()

beforeEach(async () => {
  fixture = await ledgerFixture()
  cfg = {
    db: fixture.db,
    me: [own, "alias@example.com"],
    repliesOwed: { afterDays: 2 },
    waitingOn: { afterDays: 5 },
    excludeSenders: [],
  }
})

afterEach(() => fixture.db.close())

function mail(input: {
  id: string
  at: string
  from: string
  to?: string[]
  cc?: string[]
  bcc?: string[]
  body: string
  subject?: string
  replyTo?: string
  refs?: string[]
  list?: boolean
  auto?: string
  precedence?: string
  entity?: string
  source?: string
  mailboxId?: string
  threadId?: string
}) {
  const source = input.source ?? "gmail"
  const sha = `${input.id}-${source}`.padEnd(64, "0").slice(0, 64)
  ingestBatch(fixture.db, {
    connector: source,
    stream: source,
    nextCursor: input.id,
    documents: [
      {
        sha256: sha,
        source,
        sourceRef: `${source}:${input.id}`,
        mime: "message/rfc822",
        entityId: input.entity ?? fixture.property.id,
        title: input.subject ?? "Quote",
        body: input.body,
        occurredAt: input.at,
        headers: {
          messageId: `<${input.id}@example.com>`,
          threadId: input.threadId ?? input.id,
          ...(input.replyTo === undefined ? {} : { inReplyTo: input.replyTo }),
          references: input.refs ?? [],
        },
        addresses: [
          { role: "from", address: input.from },
          ...(input.to ?? []).map((address) => ({
            role: "to" as const,
            address,
          })),
          ...(input.cc ?? []).map((address) => ({
            role: "cc" as const,
            address,
          })),
          ...(input.bcc ?? []).map((address) => ({
            role: "bcc" as const,
            address,
          })),
        ],
        mailFacts: {
          listUnsubscribe: input.list ?? false,
          ...(input.auto === undefined ? {} : { autoSubmitted: input.auto }),
          ...(input.precedence === undefined
            ? {}
            : { precedence: input.precedence }),
        },
        mailboxId: input.mailboxId ?? `${source}-account@example.invalid`,
      },
    ],
  })
  return sha
}

const run = (day: number) =>
  syncReplyObligations(new Date(Date.UTC(2026, 0, day)), cfg)

describe("reply obligations", () => {
  test("creates one sourced owed obligation at N days and deduplicates the same message across mailboxes and runs", () => {
    const sha = mail({
      id: "incoming",
      at: at(1),
      from: other,
      to: [own],
      body: "Please send the quote.",
    })
    expect(run(2).created).toBe(0)
    expect(detectReplies(new Date(Date.UTC(2026, 0, 3)), cfg)[0]?.dueAt).toBe(
      "2026-01-03T00:00:00.000Z"
    )
    expect(run(3)).toEqual({ created: 1, resolved: 0 })
    expect(run(4).created).toBe(0)
    mail({
      id: "incoming",
      at: at(1),
      from: other,
      to: [own],
      body: "Please send the quote.",
      source: "proton",
    })
    expect(run(4).created).toBe(0)
    const [obligation] = listObligations(fixture.db)
    expect(obligation).toMatchObject({
      direction: "owed",
      dueAt: "2026-01-03",
      docId: sha,
    })
    const source = String(
      fixture.db
        .prepare("SELECT body FROM document_text WHERE sha256 = ?")
        .get(sha)?.["body"]
    )
    expect(source.slice(obligation?.span.start, obligation?.span.end)).toBe(
      "Please send the quote."
    )
  })

  test.each([
    ["List-Unsubscribe", { list: true }],
    ["Auto-Submitted", { auto: "auto-generated" }],
    ["bulk precedence", { precedence: "bulk" }],
    ["no-reply sender", { from: "no-reply@example.com" }],
    ["Bcc-only owner", { to: [], bcc: [own] }],
  ])("does not create owed obligations for %s", (_name, extras) => {
    const base = {
      id: "auto",
      at: at(1),
      from: other,
      to: [own],
      body: "Please reply.",
    }
    mail({ ...base, ...extras })
    expect(run(8).created).toBe(0)
  })

  test("resolves an owed obligation on a newer plain reply without requiring another ask", () => {
    mail({
      id: "request",
      at: at(1),
      from: other,
      to: [own],
      body: "Can you review this?",
    })
    run(4)
    mail({
      id: "answer",
      at: at(4),
      from: own,
      to: [other],
      body: "Thanks.",
      replyTo: "<request@example.com>",
      refs: ["<request@example.com>"],
    })
    expect(run(4)).toEqual({ created: 0, resolved: 1 })
    expect(listObligations(fixture.db)[0]).toMatchObject({
      status: "done",
      resolutionReason: "replied",
    })
  })

  test("uses the full References chain and resolves after any newer opposite-side message", () => {
    mail({
      id: "root",
      at: at(1),
      from: other,
      to: [own],
      body: "Please review.",
    })
    run(4)
    mail({
      id: "owner-reply",
      at: at(4),
      from: own,
      to: [other],
      body: "Thanks.",
      replyTo: "<root@example.com>",
      refs: ["<root@example.com>"],
    })
    mail({
      id: "partner-followup",
      at: at(5),
      from: other,
      to: [own],
      body: "Any update?",
      replyTo: "<owner-reply@example.com>",
      refs: ["<root@example.com>", "<owner-reply@example.com>"],
    })
    expect(run(5)).toMatchObject({ created: 0, resolved: 1 })
    mail({
      id: "owner-second-reply",
      at: at(6),
      from: own,
      to: [other],
      body: "I will check.",
      replyTo: "<partner-followup@example.com>",
      refs: [
        "<root@example.com>",
        "<owner-reply@example.com>",
        "<partner-followup@example.com>",
      ],
    })
    expect(run(8).created).toBe(0)
    expect(listObligations(fixture.db)[0]?.status).toBe("done")
  })

  test("finds an obligation's current component after late ancestry joins its thread", () => {
    mail({
      id: "unlinked-inbound",
      at: at(2),
      from: other,
      to: [own],
      body: "Please reply.",
    })
    run(4)
    mail({
      id: "late-ancestor",
      at: at(1),
      from: own,
      to: [other],
      body: "Original note.",
    })
    run(4)
    mail({
      id: "later-owner-reply",
      at: at(5),
      from: own,
      to: [other],
      body: "Thanks.",
      replyTo: "<unlinked-inbound@example.com>",
      refs: ["<late-ancestor@example.com>", "<unlinked-inbound@example.com>"],
    })
    expect(run(5).resolved).toBe(1)
    expect(listObligations(fixture.db)[0]).toMatchObject({
      status: "done",
      resolutionReason: "replied",
    })
  })

  test("tracks only asks and resolves waiting when an inbound reply arrives", () => {
    mail({
      id: "sent",
      at: at(1),
      from: own,
      to: [other],
      body: "Please confirm the date.",
    })
    expect(run(5).created).toBe(0)
    expect(run(6).created).toBe(1)
    mail({
      id: "reply",
      at: at(6),
      from: other,
      to: [own],
      body: "Confirmed.",
      replyTo: "<sent@example.com>",
      refs: ["<sent@example.com>"],
    })
    expect(run(6)).toEqual({ created: 0, resolved: 1 })
    expect(listObligations(fixture.db)[0]).toMatchObject({
      status: "done",
      direction: "waiting",
      party: other,
    })
  })

  test("applies configured sender patterns to the counterparty address", () => {
    mail({
      id: "excluded",
      at: at(1),
      from: other,
      to: [own],
      body: "Please reply.",
    })
    expect(
      syncReplyObligations(new Date(Date.UTC(2026, 0, 4)), {
        ...cfg,
        excludeSenders: ["partner@example\\.com"],
      }).created
    ).toBe(0)
    expect(
      syncReplyObligations(new Date(Date.UTC(2026, 0, 4)), {
        ...cfg,
        excludeSenders: ["blocked@example\\.com"],
      }).created
    ).toBe(1)
  })

  test("does not create a waiting obligation without a counterparty recipient or source text", () => {
    mail({ id: "no-recipient", at: at(1), from: own, body: "Please confirm." })
    mail({
      id: "empty-body",
      at: at(1),
      from: own,
      to: [other],
      body: "  \n  ",
    })
    expect(run(8).created).toBe(0)
  })

  test("preserves a dismissed anchor across later runs", () => {
    mail({
      id: "dismiss",
      at: at(1),
      from: other,
      to: [own],
      body: "Please reply.",
    })
    run(4)
    fixture.db.prepare("UPDATE obligations SET status = 'dismissed'").run()
    expect(run(5).created).toBe(0)
    expect(listObligations(fixture.db)[0]?.status).toBe("dismissed")
  })

  test("does not duplicate an anchor after closing and reopening the ledger", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "eido-replies-restart-")),
      "data.db"
    )
    const db = openDataDb(path)
    db.prepare(
      "INSERT INTO entities (id, kind, name, tag, created_at) VALUES ('restart-entity', 'personal', 'Restart', 'R', '2026-01-01T00:00:00.000Z')"
    ).run()
    const raw = new TextEncoder().encode("restart message")
    const digest = sha(new TextDecoder().decode(raw))
    ingestBatch(db, {
      connector: "gmail",
      stream: "restart",
      nextCursor: "1",
      documents: [
        {
          sha256: digest,
          source: "gmail",
          sourceRef: "restart",
          mime: "message/rfc822",
          entityId: "restart-entity",
          title: "Restart",
          body: "Please reply.",
          occurredAt: at(1),
          headers: { messageId: "<restart@example.com>", threadId: "restart" },
          addresses: [
            { role: "from", address: other },
            { role: "to", address: own },
          ],
          mailFacts: { listUnsubscribe: false },
          content: raw,
        },
      ],
    })
    const restartedConfig = { ...cfg, db, ownerEntityId: "restart-entity" }
    expect(
      syncReplyObligations(new Date(Date.UTC(2026, 0, 4)), restartedConfig)
        .created
    ).toBe(1)
    db.close()
    const reopened = openDataDb(path)
    expect(
      syncReplyObligations(new Date(Date.UTC(2026, 0, 5)), {
        ...restartedConfig,
        db: reopened,
      }).created
    ).toBe(0)
    reopened.close()
  })

  test("defers writes while another ledger transaction is active and retries afterward", () => {
    mail({
      id: "external-transaction",
      at: at(1),
      from: other,
      to: [own],
      body: "Please reply.",
    })
    fixture.db.exec("BEGIN")
    expect(() => run(4)).toThrow(
      "reply obligation sync deferred while a ledger transaction is active"
    )
    expect(listObligations(fixture.db)).toEqual([])
    fixture.db.exec("ROLLBACK")
    expect(run(4).created).toBe(1)
  })

  test("isolates same RFC thread identifiers across entities", () => {
    mail({
      id: "first",
      threadId: "same-thread",
      at: at(1),
      from: other,
      to: [own],
      body: "Please reply.",
    })
    mail({
      id: "second",
      threadId: "same-thread",
      at: at(1),
      from: other,
      to: [own],
      body: "Please reply.",
      entity: fixture.company.id,
    })
    expect(run(4).created).toBe(2)
  })

  test("groups connector-native thread IDs when RFC ancestry headers are absent", () => {
    mail({
      id: "native-first",
      threadId: "gmail-thread-1",
      at: at(1),
      from: other,
      to: [own],
      body: "Please reply.",
    })
    mail({
      id: "native-last",
      threadId: "gmail-thread-1",
      at: at(2),
      from: other,
      to: [own],
      body: "Following up.",
    })
    expect(run(4).created).toBe(1)
    expect(listObligations(fixture.db)[0]?.anchorMessageId).toBe(
      "<native-last@example.com>"
    )
  })

  test("does not merge equal connector-native thread IDs from different mailbox accounts", () => {
    mail({
      id: "account-one",
      threadId: "shared-thread-id",
      mailboxId: "one@example.invalid",
      at: at(1),
      from: other,
      to: [own],
      body: "Please reply.",
    })
    mail({
      id: "account-two",
      threadId: "shared-thread-id",
      mailboxId: "two@example.invalid",
      at: at(1),
      from: other,
      to: [own],
      body: "Please reply.",
    })
    expect(run(4).created).toBe(2)
  })

  test("does not treat a legacy message without stored delivery facts as clean", () => {
    const raw = new TextEncoder().encode("synthetic legacy RFC822")
    const digest = sha(new TextDecoder().decode(raw))
    ingestBatch(fixture.db, {
      connector: "gmail",
      stream: "legacy",
      nextCursor: "legacy",
      documents: [
        {
          sha256: digest,
          source: "gmail",
          sourceRef: "legacy",
          mime: "message/rfc822",
          entityId: fixture.property.id,
          body: "Please reply.",
          occurredAt: at(1),
          headers: { messageId: "<legacy@example.com>", threadId: "legacy" },
          addresses: [
            { role: "from", address: other },
            { role: "to", address: own },
          ],
        },
      ],
    })
    expect(run(4).created).toBe(0)
    ingestBatch(fixture.db, {
      connector: "gmail",
      stream: "legacy-resync",
      nextCursor: "legacy-resync",
      documents: [
        {
          sha256: digest,
          source: "gmail",
          sourceRef: "legacy",
          mime: "message/rfc822",
          entityId: fixture.property.id,
          body: "Please reply.",
          occurredAt: at(1),
          headers: { messageId: "<legacy@example.com>", threadId: "legacy" },
          addresses: [
            { role: "from", address: other },
            { role: "to", address: own },
          ],
          mailFacts: { listUnsubscribe: false },
          content: raw,
        },
      ],
    })
    expect(run(4).created).toBe(1)
  })
})
