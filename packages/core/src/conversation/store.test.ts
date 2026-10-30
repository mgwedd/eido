import { rmSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { compactConversation } from "./compact"
import {
  rawTurn,
  storeFixture,
  summarizingModel,
  words,
} from "./conversation.test-support"
import type { StoreFixture } from "./conversation.test-support"

let fixture: StoreFixture
afterEach(() => {
  fixture.cleanup()
})

function seed(): StoreFixture {
  fixture = storeFixture()
  const { store } = fixture
  store.appendTurn(
    "c1",
    rawTurn(1, "Please review the zebrafish lease renewal.")
  )
  store.appendTurn(
    "c1",
    rawTurn(2, "The renewal asks for roof repair before March.")
  )
  store.appendTurn("c2", rawTurn(3, "Did we ever repair the roof last year?"))
  store.appendTurn(
    "c2",
    rawTurn(
      4,
      "Plumbing notes go here, and a long tail of other unrelated words that dilute the score, and a single mention of the lease."
    )
  )
  store.appendTurn("c3", rawTurn(5, "Lease lease lease."))
  return fixture
}

describe("raw transcript storage", () => {
  it("returns turns in order with their sources", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "first", { sources: ["M1"] }))
    fixture.store.appendTurn("c1", rawTurn(2, "second"))
    expect(fixture.store.getTurns("c1")).toEqual([
      rawTurn(1, "first", { sources: ["M1"] }),
      rawTurn(2, "second"),
    ])
    expect(fixture.store.getTurns("nope")).toEqual([])
  })

  it("rejects a turn whose timestamp is not a date", () => {
    fixture = storeFixture()
    expect(() => {
      fixture.store.appendTurn("c1", rawTurn(1, "x", { at: "yesterday" }))
    }).toThrow("ISO 8601")
    expect(fixture.store.getTurns("c1")).toEqual([])
  })

  it("rejects a repeated turn id and leaves the first untouched", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "original"))
    expect(() => {
      fixture.store.appendTurn("c1", rawTurn(1, "replacement"))
    }).toThrow()
    expect(fixture.store.getTurns("c1").map((t) => t.text)).toEqual([
      "original",
    ])
  })

  it("cannot edit or delete a raw turn, or change or delete a conversation", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "keep me"))
    const { db } = fixture
    expect(() => db.exec("UPDATE conversation_turns SET text = 'x'")).toThrow(
      "immutable"
    )
    expect(() => db.exec("DELETE FROM conversation_turns")).toThrow("immutable")
    expect(() => db.exec("DELETE FROM conversations")).toThrow("immutable")
    expect(() => db.exec("UPDATE conversations SET created_at = 'x'")).toThrow(
      "immutable"
    )
    expect(() => db.exec("UPDATE conversations SET id = 'x'")).toThrow(
      "immutable"
    )
    expect(() =>
      db.exec("UPDATE conversation_turns SET role = 'user'")
    ).toThrow("immutable")
    expect(fixture.store.getTurns("c1").map((t) => t.text)).toEqual(["keep me"])
  })

  it("refuses a summary role at the table", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "x"))
    expect(() =>
      fixture.db.exec(
        "INSERT INTO conversation_turns VALUES ('s', 'c1', 9, 'summary', 't', '2025-10-10T00:00:00Z', '[]')"
      )
    ).toThrow()
  })

  it("moves last activity forward with each turn but never created_at", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "a"))
    fixture.clock.now = new Date("2025-10-20T12:00:00Z")
    fixture.store.appendTurn("c1", rawTurn(2, "b"))
    expect(
      fixture.db.prepare("SELECT * FROM conversations").get()
    ).toMatchObject({
      created_at: "2025-10-20T10:00:00.000Z",
      last_activity_at: "2025-10-20T12:00:00.000Z",
    })
  })
})

describe("searchConversations", () => {
  it("finds a unique word in the right conversation and turn", () => {
    seed()
    expect(fixture.store.searchConversations("zebrafish")).toMatchObject([
      { conversationId: "c1", turnId: "t1", kind: "raw" },
    ])
    expect(fixture.store.searchConversations("zebrafish")[0]?.snippet).toBe(
      "Please review the [zebrafish] lease renewal."
    )
  })

  it("matches a quoted phrase only as consecutive words", () => {
    seed()
    const hits = fixture.store.searchConversations('"roof repair"')
    expect(hits.map((h) => [h.conversationId, h.turnId])).toEqual([
      ["c1", "t2"],
    ])
    // Without quotes both words match anywhere, so the other turn qualifies too.
    expect(
      fixture.store
        .searchConversations("roof repair")
        .map((h) => h.turnId)
        .sort()
    ).toEqual(["t2", "t3"])
  })

  it("matches a prefix term and not a longer unrelated word", () => {
    seed()
    expect(
      fixture.store
        .searchConversations("renew*")
        .map((h) => h.turnId)
        .sort()
    ).toEqual(["t1", "t2"])
    expect(fixture.store.searchConversations("renew")).toEqual([])
  })

  it("finds one-letter typos after exact matches", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "A zebrafish was spotted."))
    fixture.store.appendTurn("c2", rawTurn(2, "A zebragish was spotted."))

    expect(
      fixture.store.searchConversations("zebragish").map((hit) => hit.turnId)
    ).toEqual(["t2", "t1"])
  })

  it("matches a sound-alike name", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "Please ask Steven to call."))

    expect(
      fixture.store.searchConversations("Stephen").map((hit) => hit.turnId)
    ).toEqual(["t1"])
  })

  it("does not expand typos or sound-alike terms inside quoted phrases", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "A zebrafish swam past Steven."))

    expect(fixture.store.searchConversations('"zebragish"')).toEqual([])
    expect(fixture.store.searchConversations('"Stephen"')).toEqual([])
  })

  it("ranks the best match first", () => {
    seed()
    const hits = fixture.store.searchConversations("lease")
    // t5 is nothing but the word; t4 buries one mention in a long turn.
    expect(hits[0]?.turnId).toBe("t5")
    expect(hits[hits.length - 1]?.turnId).toBe("t4")
    const scores = hits.map((h) => h.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it("honours the limit and ignores queries with no word", () => {
    seed()
    expect(
      fixture.store.searchConversations("lease", { limit: 1 })
    ).toHaveLength(1)
    expect(fixture.store.searchConversations('  "" * ')).toEqual([])
  })

  it("indexes each paragraph of a long turn and maps hits back to the turn", () => {
    fixture = storeFixture()
    fixture.store.appendTurn(
      "c1",
      rawTurn(1, "Opening paragraph.\n\nThe quokka paragraph.\n\nClosing.")
    )
    expect(fixture.store.searchConversations("quokka")).toMatchObject([
      { turnId: "t1", snippet: "The [quokka] paragraph." },
    ])
  })

  it("indexes a turn that is only whitespace as one passage without failing", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "   "))
    expect(fixture.store.getTurns("c1")).toHaveLength(1)
  })

  it("still finds the same words after the conversation has been compacted", async () => {
    seed()
    const before = fixture.store.searchConversations("zebrafish")
    const turns = fixture.store.getTurns("c1")
    const model = summarizingModel("S")
    const result = await compactConversation(
      [...turns, rawTurn(9, words(40))],
      { thresholdTokens: 30, keepRecentTokens: 5 },
      { queue: model.queue }
    )
    expect(result.compacted).toBe(true)
    expect(fixture.store.searchConversations("zebrafish")).toEqual(before)
    expect(fixture.store.searchConversations('"roof repair"')).toHaveLength(1)
    expect(fixture.store.getTurns("c1")).toEqual(turns)
  })
})

describe("the index is rebuildable", () => {
  const queries = ["lease", "zebrafish", '"roof repair"', "renew*"]
  const answers = (f: StoreFixture): unknown[] =>
    queries.map((q) => f.store.searchConversations(q))

  it("rebuilds from the raw tables after the index file is deleted, with identical results", () => {
    seed()
    const expected = answers(fixture)
    const { dir, indexPath } = fixture
    fixture.db.close()
    fixture.index.close()
    rmSync(indexPath)
    fixture = storeFixture(dir, fixture.clock)
    expect(answers(fixture)).toEqual(expected)
    expect(expected[0]).toHaveLength(3)
  })

  it("rebuilds when the index version differs", () => {
    seed()
    const expected = answers(fixture)
    fixture.index.exec("DELETE FROM passages")
    fixture.index.exec("UPDATE index_meta SET value = '0'")
    fixture = fixture.reopen()
    expect(answers(fixture)).toEqual(expected)
    expect(
      fixture.index.prepare("SELECT value FROM index_meta").get()?.["value"]
    ).toBe("1")
  })

  it("rebuilds when the index does not cover every turn", () => {
    seed()
    const expected = answers(fixture)
    fixture.index.exec("DELETE FROM passages WHERE turn_id = 't1'")
    fixture = fixture.reopen()
    expect(answers(fixture)).toEqual(expected)
  })

  it("leaves a current index alone on restart", () => {
    seed()
    fixture.index.exec("UPDATE passages SET text = 'marker passage'")
    fixture = fixture.reopen()
    expect(fixture.store.searchConversations("marker")).toHaveLength(5)
  })
})

describe("source tags", () => {
  it("assigns each source once and a new tag to each new source", () => {
    fixture = storeFixture()
    const { store } = fixture
    store.appendTurn("c1", rawTurn(1, "x"))
    expect(store.allocateSourceTag("c1", "gmail:abc")).toBe("M1")
    expect(store.allocateSourceTag("c1", "gmail:def")).toBe("M2")
    expect(store.allocateSourceTag("c1", "gmail:abc")).toBe("M1")
    expect(store.sourceTags("c1")).toEqual([
      { tag: "M1", sourceRef: "gmail:abc" },
      { tag: "M2", sourceRef: "gmail:def" },
    ])
  })

  it("numbers tags per conversation", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "x"))
    fixture.store.appendTurn("c2", rawTurn(2, "y"))
    fixture.store.allocateSourceTag("c1", "a")
    expect(fixture.store.allocateSourceTag("c2", "b")).toBe("M1")
    expect(fixture.store.resolveSourceTag("c2", "M1")).toBe("b")
    expect(fixture.store.resolveSourceTag("c1", "M1")).toBe("a")
  })

  it("keeps a tag on the same source after compaction, digest and restart, and never reuses it", async () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, words(20)))
    fixture.store.appendTurn("c1", rawTurn(2, words(20)))
    const tag = fixture.store.allocateSourceTag("c1", "doc:lease")
    fixture.store.allocateSourceTag("c1", "doc:other")

    await compactConversation(
      fixture.store.getTurns("c1"),
      { thresholdTokens: 10, keepRecentTokens: 20 },
      { queue: summarizingModel("S").queue }
    )
    fixture.store.putDigest(
      "c1",
      "digest",
      fixture.store.fingerprint("c1") ?? "",
      "2025-10-20T11:00:00Z",
      { summary: "digest", coveredTurns: 2 }
    )
    fixture = fixture.reopen()

    expect(fixture.store.resolveSourceTag("c1", tag)).toBe("doc:lease")
    expect(fixture.store.allocateSourceTag("c1", "doc:lease")).toBe(tag)
    expect(fixture.store.allocateSourceTag("c1", "doc:new")).toBe("M3")
    expect(fixture.store.resolveSourceTag("c1", "M9")).toBeUndefined()
  })

  it("cannot reassign, reuse or delete a tag at the table", () => {
    fixture = storeFixture()
    fixture.store.appendTurn("c1", rawTurn(1, "x"))
    fixture.store.allocateSourceTag("c1", "a")
    expect(() =>
      fixture.db.exec("UPDATE conversation_source_tags SET source_ref = 'z'")
    ).toThrow("never reassigned")
    expect(() =>
      fixture.db.exec("DELETE FROM conversation_source_tags")
    ).toThrow("never reused")
    expect(() =>
      fixture.db.exec(
        "INSERT INTO conversation_source_tags VALUES ('c1', 'M2', 'a')"
      )
    ).toThrow()
  })
})
