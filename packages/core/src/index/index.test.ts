import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import {
  SCHEMA_VERSION,
  countMatches,
  getCursor,
  ingestBatch,
  openIndex,
  search,
} from "./index"
import type { IndexedDocument } from "./index"
import { soundex, tokenize, withinOneEdit } from "./text"

const sha = (s: string): string => createHash("sha256").update(s).digest("hex")

function doc(id: string, over: Partial<IndexedDocument> = {}): IndexedDocument {
  return {
    sha256: sha(id),
    source: "gmail",
    sourceRef: `ref-${id}`,
    mime: "message/rfc822",
    body: "",
    ...over,
  }
}

let db: DatabaseSync
const ingest = (documents: IndexedDocument[], nextCursor = "c1") =>
  ingestBatch(db, {
    connector: "gmail",
    stream: "inbox",
    documents,
    nextCursor,
  })

beforeEach(() => {
  db = openIndex(":memory:")
})

describe("schema", () => {
  test("sets the schema version", () => {
    expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
      SCHEMA_VERSION
    )
  })

  test("rejects a database from a newer version", () => {
    const path = join(mkdtempSync(join(tmpdir(), "eido-idx-")), "t.db")
    const first = openIndex(path)
    first.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    first.close()
    expect(() => openIndex(path)).toThrow(/newer/)
  })

  test("reopening an existing current-version database keeps its data", () => {
    const path = join(mkdtempSync(join(tmpdir(), "eido-idx-")), "t.db")
    const a = openIndex(path)
    ingestBatch(a, {
      connector: "c",
      stream: "s",
      documents: [doc("x", { body: "hello" })],
      nextCursor: "1",
    })
    a.close()
    const b = openIndex(path)
    expect(countMatches(b, { text: "hello" })).toBe(1)
    b.close()
  })

  test("documents are immutable", () => {
    ingest([doc("a", { body: "x" })])
    expect(() => db.exec("UPDATE documents SET mime = 'x'")).toThrow(
      /immutable/
    )
    expect(() => db.exec("DELETE FROM documents")).toThrow(/immutable/)
    expect(() => db.exec("UPDATE document_text SET body = 'y'")).toThrow(
      /immutable/
    )
    expect(() => db.exec("DELETE FROM document_text")).toThrow(/immutable/)
  })
})

describe("ingestBatch and cursors", () => {
  test("re-ingesting the same batch is idempotent", () => {
    const batch = [doc("a", { body: "one" }), doc("b", { body: "two" })]
    expect(ingest(batch)).toEqual({
      inserted: 2,
      skipped: 0,
      uidvalidityChanged: false,
    })
    expect(ingest(batch, "c2")).toEqual({
      inserted: 0,
      skipped: 2,
      uidvalidityChanged: false,
    })
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()?.["n"]).toBe(
      2
    )
    expect(getCursor(db, "gmail", "inbox")?.cursor).toBe("c2")
  })

  test("returns null cursor when none stored", () => {
    expect(getCursor(db, "gmail", "inbox")).toBeNull()
  })

  test("a failing batch rolls back documents and cursor", () => {
    ingest([doc("a", { body: "kept" })], "c1")
    const bad = doc("b", {
      body: "lost",
      content: new TextEncoder().encode("different"),
    })
    expect(() => ingest([doc("c", { body: "also lost" }), bad], "c2")).toThrow(
      /mismatch/
    )
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()?.["n"]).toBe(
      1
    )
    expect(countMatches(db, { text: "lost" })).toBe(0)
    expect(getCursor(db, "gmail", "inbox")?.cursor).toBe("c1")
  })

  test("accepts matching content bytes", () => {
    const content = new TextEncoder().encode("abc")
    const d = doc("abc", { body: "abc", content })
    d.sha256 = createHash("sha256").update(content).digest("hex")
    expect(ingest([d]).inserted).toBe(1)
  })

  test("changed uidvalidity keeps the old cursor and writes nothing", () => {
    ingestBatch(db, {
      connector: "p",
      stream: "inbox",
      documents: [doc("a", { body: "x" })],
      nextCursor: "7",
      uidvalidity: "1",
    })
    const r = ingestBatch(db, {
      connector: "p",
      stream: "inbox",
      documents: [doc("b", { body: "y" })],
      nextCursor: "9",
      uidvalidity: "2",
    })
    expect(r).toEqual({ inserted: 0, skipped: 0, uidvalidityChanged: true })
    expect(getCursor(db, "p", "inbox")).toEqual({
      cursor: "7",
      uidvalidity: "1",
    })
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()?.["n"]).toBe(
      1
    )
  })

  test("same uidvalidity advances the cursor", () => {
    ingestBatch(db, {
      connector: "p",
      stream: "i",
      documents: [],
      nextCursor: "1",
      uidvalidity: "1",
    })
    ingestBatch(db, {
      connector: "p",
      stream: "i",
      documents: [],
      nextCursor: "2",
      uidvalidity: "1",
    })
    expect(getCursor(db, "p", "i")).toEqual({ cursor: "2", uidvalidity: "1" })
  })

  test("stores headers, entity id, blob path and skips unusable names", () => {
    ingest([
      doc("h", {
        body: "b",
        entityId: "e1",
        blobPath: "blobs/h",
        headers: {
          messageId: "<m@example.invalid>",
          inReplyTo: "<p@example.invalid>",
          references: ["<p@example.invalid>"],
          threadId: "t1",
          attachmentOf: "x",
        },
        names: [{ role: "from", name: "12345" }],
      }),
    ])
    const row = db.prepare("SELECT * FROM document_text").get()
    expect(row?.["references_json"]).toBe('["<p@example.invalid>"]')
    expect(row?.["thread_id"]).toBe("t1")
    expect(db.prepare("SELECT COUNT(*) AS n FROM name_keys").get()?.["n"]).toBe(
      0
    )
  })
})

describe("search ranking", () => {
  test("repeated term in a short title outranks one mention in a long body; score is monotonic", () => {
    const filler = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")
    ingest([
      doc("long", {
        title: "Weekly notes",
        body: `${filler} budget ${filler}`,
      }),
      doc("short", { title: "Budget budget budget", body: "see attached" }),
      doc("mid", { title: "Plan", body: "the budget is due" }),
    ])
    const hits = search(db, { text: "budget" })
    expect(hits[0]?.sha256).toBe(sha("short"))
    expect(hits.at(-1)?.sha256).toBe(sha("long"))
    const scores = hits.map((h) => h.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
    expect(new Set(scores).size).toBe(3)
  })

  test("ties break by newest then sha256", () => {
    ingest([
      doc("a", { body: "same text", occurredAt: "2026-01-01T00:00:00Z" }),
      doc("b", { body: "same text", occurredAt: "2026-02-01T00:00:00Z" }),
    ])
    expect(search(db, { text: "same" }).map((h) => h.occurredAt)).toEqual([
      "2026-02-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ])
  })

  test("limit, source filter and hit fields", () => {
    ingest([
      doc("a", {
        title: "T",
        body: "alpha",
        occurredAt: "2026-01-01T00:00:00Z",
      }),
      doc("b", { source: "files", body: "alpha" }),
    ])
    expect(search(db, { text: "alpha", limit: 1 })).toHaveLength(1)
    const hits = search(db, { text: "alpha", source: "files" })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ source: "files", sourceRef: "ref-b" })
    expect(hits[0]).not.toHaveProperty("title")
    expect(search(db, { text: "alpha", source: "gmail" })[0]).toMatchObject({
      title: "T",
      occurredAt: "2026-01-01T00:00:00Z",
    })
  })
})

describe("typo matching", () => {
  beforeEach(() => {
    ingest([
      doc("inv", { body: "Please pay the invoice today" }),
      doc("cat", { body: "the cat sat" }),
    ])
  })

  test("one typo finds the term", () => {
    expect(search(db, { text: "invoce" })).toHaveLength(1)
    expect(search(db, { text: "invocie" })).toHaveLength(1) // transposition
    expect(search(db, { text: "invoicee" })).toHaveLength(1) // insertion
  })

  test("short terms match exactly only", () => {
    expect(search(db, { text: "cot" })).toHaveLength(0)
  })

  test("fuzzy false disables expansion", () => {
    expect(search(db, { text: "invoce", fuzzy: false })).toHaveLength(0)
  })

  test("two typos do not match", () => {
    expect(search(db, { text: "invxxce" })).toHaveLength(0)
  })

  test("edit distance helper", () => {
    expect(withinOneEdit("abc", "abc")).toBe(true)
    expect(withinOneEdit("abc", "abd")).toBe(true)
    expect(withinOneEdit("abc", "acb")).toBe(true)
    expect(withinOneEdit("abc", "xbc")).toBe(true)
    expect(withinOneEdit("abcd", "abd")).toBe(true)
    expect(withinOneEdit("abc", "abcd")).toBe(true)
    expect(withinOneEdit("abc", "xyz")).toBe(false)
    expect(withinOneEdit("abc", "abxyz")).toBe(false)
    expect(withinOneEdit("abcd", "abdc")).toBe(true)
    expect(withinOneEdit("abcd", "abxy")).toBe(false)
  })
})

describe("sound-alike names", () => {
  beforeEach(() => {
    ingest([
      doc("smith", {
        body: "Lunch on Friday?",
        names: [
          { role: "from", name: "John Smith" },
          { role: "to", name: "Ana Díaz" },
        ],
      }),
      doc("brown", {
        body: "Lunch on Friday?",
        names: [{ role: "from", name: "Joan Brown" }],
      }),
    ])
  })

  test("Jon Smyth finds John Smith and not Joan Brown", () => {
    const hits = search(db, { text: "Jon Smyth" })
    expect(hits.map((h) => h.sha256)).toEqual([sha("smith")])
    expect(hits[0]?.snippets).toEqual([])
    expect(countMatches(db, { text: "Jon Smyth" })).toBe(1)
  })

  test("combines with word terms and filters", () => {
    expect(
      search(db, { text: "Jon lunch" })
        .map((h) => h.sha256)
        .sort()
    ).toEqual([sha("brown"), sha("smith")].sort())
    expect(search(db, { text: "Smyth lunch", source: "gmail" })).toHaveLength(1)
    expect(search(db, { text: "Smyth", after: "2030-01-01" })).toHaveLength(0)
  })

  test("accented names are keyed", () => {
    expect(search(db, { text: "Diaz" })).toHaveLength(1)
  })

  test("soundex", () => {
    expect(soundex("Robert")).toBe("R163")
    expect(soundex("Ashcraft")).toBe("A261")
    expect(soundex("Tymczak")).toBe("T522")
    expect(soundex("Lee")).toBe("L000")
    expect(soundex("123")).toBeNull()
  })
})

describe("date filters", () => {
  beforeEach(() => {
    ingest([
      doc("d1", { body: "memo", occurredAt: "2026-03-01T00:00:00Z" }),
      doc("d2", { body: "memo", occurredAt: "2026-04-01T00:00:00Z" }),
      doc("undated", { body: "memo" }),
    ])
  })
  const refs = (q: { after?: string; before?: string }) =>
    search(db, { text: "memo", ...q })
      .map((h) => h.sourceRef)
      .sort()

  test("after is inclusive, before is exclusive, undated excluded", () => {
    expect(refs({})).toEqual(["ref-d1", "ref-d2", "ref-undated"])
    expect(refs({ after: "2026-03-01T00:00:00Z" })).toEqual([
      "ref-d1",
      "ref-d2",
    ])
    expect(refs({ after: "2026-03-01T00:00:01Z" })).toEqual(["ref-d2"])
    expect(refs({ before: "2026-04-01T00:00:00Z" })).toEqual(["ref-d1"])
    expect(refs({ before: "2026-04-01T00:00:01Z" })).toEqual([
      "ref-d1",
      "ref-d2",
    ])
    expect(
      refs({ after: "2026-03-01T00:00:00Z", before: "2026-04-01T00:00:00Z" })
    ).toEqual(["ref-d1"])
  })
})

describe("context snippets", () => {
  const lines = (n: number, hits: Record<number, string>) =>
    Array.from({ length: n }, (_, i) => hits[i + 1] ?? `filler ${i + 1}`).join(
      "\n"
    )

  test("hit on line 6 of 12 returns lines 4 to 8", () => {
    ingest([doc("a", { body: lines(12, { 6: "the needle is here" }) })])
    const [hit] = search(db, { text: "needle" })
    expect(hit?.snippets).toHaveLength(1)
    const s = hit?.snippets[0]
    expect(s?.fromLine).toBe(4)
    expect(s?.lines.map((l) => l.n)).toEqual([4, 5, 6, 7, 8])
    expect(s?.lines.filter((l) => l.hit).map((l) => l.n)).toEqual([6])
  })

  test("two hits within 4 lines merge", () => {
    ingest([doc("a", { body: lines(12, { 5: "needle", 8: "needle" }) })])
    const snippets = search(db, { text: "needle" })[0]?.snippets
    expect(snippets).toHaveLength(1)
    expect(snippets?.[0]?.lines.map((l) => l.n)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10,
    ])
  })

  test("distant hits stay separate", () => {
    ingest([doc("a", { body: lines(20, { 2: "needle", 15: "needle" }) })])
    expect(
      search(db, { text: "needle" })[0]?.snippets.map((s) => s.fromLine)
    ).toEqual([1, 13])
  })

  test("hit on line 1 returns lines 1 to 3", () => {
    ingest([doc("a", { body: lines(12, { 1: "needle" }) })])
    expect(
      search(db, { text: "needle" })[0]?.snippets[0]?.lines.map((l) => l.n)
    ).toEqual([1, 2, 3])
  })

  test("title-only hit has no body snippets", () => {
    ingest([doc("a", { title: "needle", body: "nothing here" })])
    expect(search(db, { text: "needle" })[0]?.snippets).toEqual([])
  })
})

describe("malformed queries and counts", () => {
  beforeEach(() => {
    ingest([doc("a", { body: "unbalanced a or near things" })])
  })

  test.each([
    '"unbalanced',
    "a OR",
    "NEAR(",
    "foo*",
    "col:val",
    "((",
    "-x",
    "",
  ])("%j does not throw", (text) => {
    expect(() => search(db, { text })).not.toThrow()
    expect(() => countMatches(db, { text })).not.toThrow()
  })

  test("operators are treated as plain words", () => {
    expect(search(db, { text: '"unbalanced' })).toHaveLength(1)
    expect(search(db, { text: "" })).toEqual([])
    expect(countMatches(db, { text: "" })).toBe(0)
  })

  test("countMatches equals search length for the same filters", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      doc(`m${i}`, {
        body: "shared term",
        occurredAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      })
    )
    ingest(many)
    const q = {
      text: "shared",
      after: "2026-01-05T00:00:00Z",
      before: "2026-01-25T00:00:00Z",
      source: "gmail",
    }
    expect(countMatches(db, q)).toBe(20)
    expect(search(db, { ...q, limit: 1000 })).toHaveLength(20)
    expect(search(db, { text: "shared" })).toHaveLength(20) // default limit
    expect(countMatches(db, { text: "shared" })).toBe(30)
  })
})

describe("text helpers", () => {
  test("tokenize", () => {
    expect(tokenize("Héllo, Wörld-42!")).toEqual(["hello", "world", "42"])
    expect(tokenize("!!!")).toEqual([])
  })
})
