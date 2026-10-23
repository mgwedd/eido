import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import type { Entity } from "../profile/types"
import {
  deriveHeaderLinks,
  insertLinks,
  insertObligation,
  linksFor,
} from "./index"
import type { HeaderLinkMessage, HeaderLinkResolver, Link } from "./index"
import { addDocs, ledgerFixture, sha, testDoc } from "./ledger.test-support"

// A synthetic five-message thread: m1 starts it, m2 and m3 reply to m1, m4 replies to m3,
// m5 replies to m4. att1 is an attachment of m3.
const MID = (n: number) => `<m${n}@example.invalid>`
const DOC = (name: string) => sha(name)
const THREAD = "thread-1"

const MESSAGES: HeaderLinkMessage[] = [
  { docSha256: DOC("m1"), messageId: MID(1), threadId: THREAD },
  {
    docSha256: DOC("m2"),
    messageId: MID(2),
    inReplyTo: MID(1),
    references: [MID(1)],
    threadId: THREAD,
  },
  {
    docSha256: DOC("m3"),
    messageId: MID(3),
    inReplyTo: MID(1),
    references: [MID(1)],
    threadId: THREAD,
  },
  {
    docSha256: DOC("m4"),
    messageId: MID(4),
    inReplyTo: MID(3),
    references: [MID(1), MID(3)],
    threadId: THREAD,
  },
  {
    docSha256: DOC("m5"),
    messageId: MID(5),
    inReplyTo: MID(4),
    references: [MID(1), MID(3), MID(4)],
    threadId: THREAD,
  },
  {
    docSha256: DOC("att1"),
    messageId: "<att1@example.invalid>",
    attachmentOf: MID(3),
  },
]

const resolver: HeaderLinkResolver = {
  message: (messageId) => {
    const found = MESSAGES.find((m) => m.messageId === messageId)
    return found === undefined ? null : found.docSha256
  },
  threadRoot: (threadId) => (threadId === THREAD ? DOC("m1") : null),
}

const derive = (): Link[] =>
  MESSAGES.flatMap((m) => deriveHeaderLinks(m, resolver))

const edge = (
  from: string,
  kind: Link["kind"],
  to: string,
  header: string
): Link => ({
  src: `doc:${DOC(from)}`,
  dst: `doc:${DOC(to)}`,
  kind,
  confidence: 1,
  origin: `header:${header}`,
})

describe("deriveHeaderLinks", () => {
  test("a five-message thread with an attachment gives these edges, in this order", () => {
    expect(derive()).toEqual([
      edge("m2", "reply_to", "m1", "in-reply-to"),
      edge("m2", "references", "m1", "references"),
      edge("m2", "thread", "m1", "thread-id"),
      edge("m3", "reply_to", "m1", "in-reply-to"),
      edge("m3", "references", "m1", "references"),
      edge("m3", "thread", "m1", "thread-id"),
      edge("m4", "reply_to", "m3", "in-reply-to"),
      edge("m4", "references", "m1", "references"),
      edge("m4", "references", "m3", "references"),
      edge("m4", "thread", "m1", "thread-id"),
      edge("m5", "reply_to", "m4", "in-reply-to"),
      edge("m5", "references", "m1", "references"),
      edge("m5", "references", "m3", "references"),
      edge("m5", "references", "m4", "references"),
      edge("m5", "thread", "m1", "thread-id"),
      edge("att1", "attachment_of", "m3", "attachment-of"),
    ])
  })

  test("running it twice yields identical rows in identical order", () => {
    expect(derive()).toEqual(derive())
  })

  test("a reply to an unknown message ID, or an unknown thread, yields no edge", () => {
    expect(
      deriveHeaderLinks(
        {
          docSha256: DOC("stray"),
          messageId: "<stray@example.invalid>",
          inReplyTo: "<unknown@example.invalid>",
          references: ["<unknown@example.invalid>"],
          threadId: "thread-unknown",
          attachmentOf: "<unknown@example.invalid>",
        },
        resolver
      )
    ).toEqual([])
  })

  test("a repeated References entry gives one edge, and a document never links to itself", () => {
    expect(
      deriveHeaderLinks(
        {
          docSha256: DOC("m4"),
          messageId: MID(4),
          references: [MID(3), MID(3), MID(4)],
        },
        resolver
      )
    ).toEqual([edge("m4", "references", "m3", "references")])
  })
})

// SQLite's ORDER BY src, dst, kind; the ids are ASCII, so code-unit order matches its binary order.
const sortKey = (l: Link): string => `${l.src}\u0000${l.dst}\u0000${l.kind}`

describe("insertLinks and linksFor", () => {
  let db: DatabaseSync
  let property: Entity

  beforeEach(async () => {
    ;({ db, property } = await ledgerFixture())
    addDocs(
      db,
      ["m1", "m2", "m3", "m4", "m5", "att1"].map((name) =>
        testDoc(name, { entityId: property.id })
      )
    )
  })

  test("re-inserting the same links is a no-op", () => {
    expect(insertLinks(db, derive())).toBe(16)
    expect(insertLinks(db, derive())).toBe(0)
    expect(db.prepare("SELECT count(*) AS n FROM links").get()?.["n"]).toBe(16)
    expect(linksFor(db, `doc:${DOC("m3")}`)).toEqual(
      [
        edge("m3", "reply_to", "m1", "in-reply-to"),
        edge("m3", "references", "m1", "references"),
        edge("m3", "thread", "m1", "thread-id"),
        edge("m4", "reply_to", "m3", "in-reply-to"),
        edge("m4", "references", "m3", "references"),
        edge("m5", "references", "m3", "references"),
        edge("att1", "attachment_of", "m3", "attachment-of"),
      ].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))
    )
  })

  test("matched edges are stored with confidence below 1; the database refuses 1 for them and below 1 for header edges", () => {
    const obligation = insertObligation(db, {
      entityId: property.id,
      action: "Pay the invoice",
      status: "open",
      docId: DOC("m1"),
      span: { start: 0, end: 4 },
    })
    const matched: Link = {
      src: `obl:${obligation}`,
      dst: "party:Example Utility",
      kind: "about_party",
      confidence: 0.8,
      origin: "match",
    }
    expect(insertLinks(db, [matched])).toBe(1)
    expect(linksFor(db, `obl:${obligation}`)).toEqual([matched])
    expect(() =>
      insertLinks(db, [{ ...matched, dst: "party:Other", confidence: 1 }])
    ).toThrow(/CHECK/)
    expect(() =>
      insertLinks(db, [
        { ...edge("m2", "reply_to", "m1", "in-reply-to"), confidence: 0.9 },
      ])
    ).toThrow(/CHECK/)
    expect(() =>
      insertLinks(db, [{ ...matched, dst: "nowhere" as `ent:${string}` }])
    ).toThrow(/CHECK/)
  })

  test("doc: and obl: endpoints must exist; a failed batch stores nothing", () => {
    const stored = insertObligation(db, {
      entityId: property.id,
      action: "Pay the invoice",
      status: "open",
      docId: DOC("m1"),
      span: { start: 0, end: 4 },
    })
    expect(stored).toBe(1)
    const good = edge("m2", "reply_to", "m1", "in-reply-to")
    expect(() =>
      insertLinks(db, [good, { ...good, dst: `doc:${DOC("missing")}` }])
    ).toThrow(/endpoint does not exist/)
    expect(() =>
      insertLinks(db, [{ ...good, src: `doc:${DOC("missing")}` }])
    ).toThrow(/endpoint does not exist/)
    for (const id of ["obl:999", "obl:1x"] as const) {
      expect(() =>
        insertLinks(db, [
          {
            src: `doc:${DOC("m1")}`,
            dst: id as `obl:${number}`,
            kind: "references",
            confidence: 0.5,
            origin: "match",
          },
        ])
      ).toThrow(/endpoint does not exist/)
      expect(() =>
        insertLinks(db, [
          {
            src: id as `obl:${number}`,
            dst: `doc:${DOC("m1")}`,
            kind: "references",
            confidence: 0.5,
            origin: "match",
          },
        ])
      ).toThrow(/endpoint does not exist/)
    }
    expect(db.prepare("SELECT count(*) AS n FROM links").get()?.["n"]).toBe(0)
  })

  test("stored links cannot be changed", () => {
    insertLinks(db, [edge("m2", "reply_to", "m1", "in-reply-to")])
    expect(() => db.exec("UPDATE links SET confidence = 0.5")).toThrow(
      /immutable/
    )
  })
})
