import { afterEach, describe, expect, it, vi } from "vitest"
import { ingestBatch } from "../index/ingest"
import type { IndexedDocument } from "../index/ingest"
import { ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import { scheduleIngestedDigests } from "./ingest"
import type { DigestSubject } from "./types"

let fixture: Awaited<ReturnType<typeof ledgerFixture>> | undefined

afterEach(() => {
  fixture?.db.close()
  fixture = undefined
})

describe("ingested digest triggers", () => {
  it("schedules a page-cited document digest only when stored page provenance exists", async () => {
    fixture = await ledgerFixture()
    const document: IndexedDocument = {
      ...testDoc("pdf", {
        mime: "application/pdf",
        entityId: fixture.property.id,
        body: "first page\nsecond page",
        pages: [
          { page: 1, text: "first page" },
          { page: 2, text: "second page" },
        ],
      }),
    }
    const scheduleDigest = vi.fn<(subject: DigestSubject) => void>()
    ingestBatch(fixture.db, {
      connector: "gmail",
      stream: "inbox",
      documents: [document],
      nextCursor: "c1",
    })

    scheduleIngestedDigests(fixture.db, { scheduleDigest }, [document])

    expect(scheduleDigest).toHaveBeenCalledWith({
      kind: "document",
      docSha256: document.sha256,
      pages: [
        { page: 1, text: "first page" },
        { page: 2, text: "second page" },
      ],
    })
  })

  it("schedules a thread rebuild from all committed messages when a new message arrives", async () => {
    fixture = await ledgerFixture()
    const first = testDoc("mail-1", {
      entityId: fixture.property.id,
      headers: { threadId: "thread-real", messageId: "one@example.invalid" },
    })
    const added = testDoc("mail-2", {
      entityId: fixture.property.id,
      body: "The second stored message.",
      headers: { threadId: "thread-real", inReplyTo: "one@example.invalid" },
    })
    const unrelated = testDoc("other-provider-mail", {
      source: "proton",
      entityId: fixture.company.id,
      headers: {
        threadId: "thread-real",
        messageId: "other-provider@example.invalid",
      },
    })
    ingestBatch(fixture.db, {
      connector: "gmail",
      stream: "inbox",
      documents: [first],
      nextCursor: "c1",
    })
    ingestBatch(fixture.db, {
      connector: "gmail",
      stream: "inbox",
      documents: [added],
      nextCursor: "c2",
    })
    ingestBatch(fixture.db, {
      connector: "proton",
      stream: "inbox",
      documents: [unrelated],
      nextCursor: "c1",
    })
    const scheduleDigest = vi.fn<(subject: DigestSubject) => void>()

    scheduleIngestedDigests(fixture.db, { scheduleDigest }, [added])

    expect(scheduleDigest).toHaveBeenCalledWith({
      kind: "thread",
      threadId: JSON.stringify(["gmail", fixture.property.id, "thread-real"]),
      messages: [
        { id: "one@example.invalid", body: first.body },
        {
          id: "ref-mail-2",
          body: added.body,
          inReplyTo: "one@example.invalid",
        },
      ],
    })
  })

  it("does not invent page one for documents without persisted parser pages", async () => {
    fixture = await ledgerFixture()
    const old = testDoc("legacy", {
      mime: "application/pdf",
      entityId: fixture.property.id,
    })
    ingestBatch(fixture.db, {
      connector: "drive",
      stream: "files",
      documents: [old],
      nextCursor: "c1",
    })
    const scheduleDigest = vi.fn<(subject: DigestSubject) => void>()

    scheduleIngestedDigests(fixture.db, { scheduleDigest }, [old])

    expect(scheduleDigest).not.toHaveBeenCalled()
  })
})
