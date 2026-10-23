import { afterEach, describe, expect, it } from "vitest"
import { compactConversation } from "./compact"
import {
  rawTurn,
  storeFixture,
  stubModel,
  summarizingModel,
  words,
} from "./conversation.test-support"
import type { StoreFixture } from "./conversation.test-support"
import { runDigestSweep } from "./digest"
import { deriveDigestFingerprint } from "./fingerprint"

let fixture: StoreFixture
afterEach(() => {
  fixture.cleanup()
})

const minutes = (n: number): Date =>
  new Date(Date.UTC(2025, 9, 20, 10, 0, 0) + n * 60_000)

/** A conversation whose last turn lands at the fixture clock's 10:00 UTC. */
function seed(): void {
  fixture = storeFixture()
  fixture.store.appendTurn(
    "c1",
    rawTurn(1, "Is the walrus contract signed for Oct 31?", { sources: ["M1"] })
  )
  fixture.store.appendTurn("c1", rawTurn(2, "Yes, see [M1]."))
}

const sweep = (
  model: { queue: ReturnType<typeof summarizingModel>["queue"] },
  at: Date,
  ttl?: number
) =>
  runDigestSweep(fixture.store, {
    queue: model.queue,
    now: () => at,
    ...(ttl === undefined ? {} : { config: { digestIdleTtlMinutes: ttl } }),
  })

const digestRows = (): unknown[] =>
  fixture.db.prepare("SELECT * FROM conversation_digests").all()

describe("the idle digest job", () => {
  it("builds nothing before the TTL and a digest once the conversation has idled past it", async () => {
    seed()
    const model = summarizingModel("Contract talk.")

    const early = await sweep(model, minutes(59))
    expect(early).toEqual({ built: [], failed: [] })
    expect(digestRows()).toHaveLength(0)
    expect(model.requests).toHaveLength(0)

    const due = await sweep(model, minutes(60))
    expect(due.built).toEqual(["c1"])
    const digest = fixture.store.getConversationDigest("c1")
    expect(digest?.text).toBe(
      "Contract talk.\nPreserved references: Oct 31; M1"
    )
    expect(digest?.parentRawFingerprint).toBe(fixture.store.fingerprint("c1"))
    expect(digest?.fingerprint).toBe(
      deriveDigestFingerprint(
        digest?.parentRawFingerprint ?? "",
        digest?.text ?? ""
      )
    )
    expect(digest?.createdAt).toBe(minutes(60).toISOString())
  })

  it("summarizes the whole raw transcript, even a short one, on the background lane", async () => {
    seed()
    const lanes: string[] = []
    const model = summarizingModel("S")
    const queue = {
      ...model.queue,
      run: (
        lane: "foreground" | "background",
        job: Parameters<typeof model.queue.run>[1]
      ) => {
        lanes.push(lane)
        return model.queue.run(lane, job)
      },
    } as typeof model.queue
    await runDigestSweep(fixture.store, { queue, now: () => minutes(90) })
    expect(lanes).toEqual(["background"])
    expect(model.requests[0]?.messages[0]?.content).toContain("walrus")
    expect(model.requests[0]?.messages[0]?.content).toContain("Yes, see [M1].")
  })

  it("does not rebuild a digest that is up to date", async () => {
    seed()
    const model = summarizingModel("S")
    await sweep(model, minutes(60))
    const again = await sweep(model, minutes(500))
    expect(again.built).toEqual([])
    expect(model.requests).toHaveLength(1)
  })

  it("reads the TTL from configuration: default 60 minutes, and a changed value moves the build", async () => {
    seed()
    const model = summarizingModel("S")
    expect((await sweep(model, minutes(90), 120)).built).toEqual([])
    expect((await sweep(model, minutes(90), 91)).built).toEqual([])
    expect((await sweep(model, minutes(90), 90)).built).toEqual(["c1"])
  })

  it("uses the 60 minute default when configuration sets nothing", async () => {
    seed()
    const model = summarizingModel("S")
    expect((await sweep(model, minutes(59))).built).toEqual([])
    expect((await sweep(model, minutes(61))).built).toEqual(["c1"])
  })

  it("reports a failed compaction and stores no digest", async () => {
    seed()
    const result = await sweep(
      stubModel(() => "not json"),
      minutes(61)
    )
    expect(result.built).toEqual([])
    expect(result.failed).toEqual([
      {
        conversationId: "c1",
        error: {
          kind: "model_failed",
          message: "the model did not return a complete summary",
        },
      },
    ])
    expect(digestRows()).toHaveLength(0)
  })

  it("does not store rolling in-flight compactions", async () => {
    seed()
    fixture.store.appendTurn("c1", rawTurn(3, words(60)))
    const result = await compactConversation(
      fixture.store.getTurns("c1"),
      { thresholdTokens: 30, keepRecentTokens: 10 },
      { queue: summarizingModel("S").queue }
    )
    expect(result.compacted).toBe(true)
    expect(digestRows()).toHaveLength(0)
    expect(fixture.store.searchConversations("S", { kind: "digest" })).toEqual(
      []
    )
    expect(
      fixture.db.prepare("SELECT count(*) AS n FROM conversation_turns").get()
    ).toEqual({ n: 3 })
  })
})

describe("digest search and retrieval", () => {
  it("finds the digest by kind, not among raw hits, and retrieves it with its parent link", async () => {
    seed()
    await sweep(
      summarizingModel("The pangolin clause was agreed."),
      minutes(60)
    )

    const hits = fixture.store.searchConversations("pangolin", {
      kind: "digest",
    })
    expect(hits).toMatchObject([{ conversationId: "c1", kind: "digest" }])
    expect(hits[0]?.turnId).toBeUndefined()
    expect(
      fixture.store.searchConversations("pangolin", { kind: "raw" })
    ).toEqual([])
    expect(
      fixture.store.searchConversations("pangolin").map((h) => h.kind)
    ).toEqual(["digest"])

    const [context, ...rest] = fixture.store.retrieveContext("pangolin")
    expect(rest).toEqual([])
    expect(context).toMatchObject({
      conversationId: "c1",
      parentRawFingerprint: fixture.store.fingerprint("c1"),
    })
    expect(context?.text).toContain("pangolin clause")
    expect(context?.fingerprint).toBe(
      deriveDigestFingerprint(
        context?.parentRawFingerprint ?? "",
        context?.text ?? ""
      )
    )
  })

  it("returns one context entry per conversation even when several paragraphs match", async () => {
    seed()
    await sweep(
      summarizingModel("Ocelot one.\n\nOcelot two.\n\nOcelot three."),
      minutes(60)
    )
    expect(fixture.store.retrieveContext("ocelot")).toHaveLength(1)
  })

  it("respects the limit across conversations and finds nothing for an unknown word", async () => {
    seed()
    fixture.store.appendTurn("c2", rawTurn(7, "second thread"))
    await sweep(summarizingModel("Shared topic: marmots."), minutes(60))
    expect(fixture.store.retrieveContext("marmots")).toHaveLength(2)
    expect(fixture.store.retrieveContext("marmots", { limit: 1 })).toHaveLength(
      1
    )
    expect(fixture.store.retrieveContext("narwhal")).toEqual([])
  })

  it("restores digest search entries when the index is rebuilt", async () => {
    seed()
    await sweep(summarizingModel("The pangolin clause."), minutes(60))
    const expected = fixture.store.searchConversations("pangolin")
    fixture.index.exec("DELETE FROM passages")
    fixture = fixture.reopen()
    expect(fixture.store.searchConversations("pangolin")).toEqual(expected)
  })
})

describe("resuming a conversation", () => {
  it("supersedes the digest after a new turn and a second idle period", async () => {
    seed()
    await sweep(summarizingModel("Old lemur summary."), minutes(60))
    const old = fixture.store.getConversationDigest("c1")

    // The conversation resumes: its digest no longer matches the raw transcript.
    fixture.clock.now = minutes(120)
    fixture.store.appendTurn(
      "c1",
      rawTurn(3, "One more thing about the lease.")
    )

    const notYet = await sweep(summarizingModel("Never used."), minutes(150))
    expect(notYet.built).toEqual([])
    expect(fixture.store.getConversationDigest("c1")).toEqual(old)

    const next = await sweep(
      summarizingModel("New gecko summary."),
      minutes(180)
    )
    expect(next.built).toEqual(["c1"])
    const fresh = fixture.store.getConversationDigest("c1")
    expect(fresh?.fingerprint).not.toBe(old?.fingerprint)
    expect(fresh?.parentRawFingerprint).toBe(fixture.store.fingerprint("c1"))
    expect(fresh?.text).toContain("gecko")
    expect(digestRows()).toHaveLength(1)
    expect(
      fixture.store.searchConversations("lemur", { kind: "digest" })
    ).toEqual([])
    expect(
      fixture.store.searchConversations("gecko", { kind: "digest" })
    ).toHaveLength(1)
  })

  it("folds only the turns added since into the old digest's summary", async () => {
    seed()
    await sweep(summarizingModel("Old lemur summary."), minutes(60))
    fixture.clock.now = minutes(120)
    fixture.store.appendTurn(
      "c1",
      rawTurn(3, "One more thing about the lease.")
    )

    const model = summarizingModel("Lemur and lease.")
    expect((await sweep(model, minutes(180))).built).toEqual(["c1"])
    expect(model.requests).toHaveLength(1)
    const content = model.requests[0]?.messages[0]?.content ?? ""
    expect(content).toContain("Summary so far:\nOld lemur summary.\n")
    expect(content).not.toContain("Preserved references")
    expect(content).toContain("One more thing about the lease.")
    expect(content).not.toContain("walrus")
    // References of the turns not re-sent still come through.
    expect(fixture.store.getConversationDigest("c1")?.text).toBe(
      "Lemur and lease.\nPreserved references: Oct 31; M1"
    )
    expect(fixture.store.digestStart("c1")).toEqual({
      summary: "Lemur and lease.",
      coveredTurns: 3,
    })
  })

  it("rebuilds from the start when the stored summary does not cover these turns", async () => {
    seed()
    // A digest whose fingerprint is not of the first turns: nothing to fold into.
    fixture.store.putDigest(
      "c1",
      "Stray.",
      "not-these-turns",
      minutes(1).toISOString(),
      {
        summary: "Stray.",
        coveredTurns: 1,
      }
    )
    const model = summarizingModel("Fresh.")
    expect((await sweep(model, minutes(90))).built).toEqual(["c1"])
    const content = model.requests[0]?.messages[0]?.content ?? ""
    expect(content).not.toContain("Stray.")
    expect(content).toContain("walrus")
  })

  it("caps each summary reply", async () => {
    seed()
    const model = summarizingModel("S")
    await sweep(model, minutes(60))
    expect(model.requests[0]?.maxTokens).toBe(600)
  })

  it("is not marked due while its digest still matches the raw transcript", () => {
    seed()
    const parent = fixture.store.fingerprint("c1") ?? ""
    fixture.store.putDigest("c1", "D", parent, minutes(1).toISOString(), {
      summary: "D",
      coveredTurns: 2,
    })
    expect(fixture.store.dueForDigest(minutes(600), 60)).toEqual([])
    fixture.store.appendTurn("c1", rawTurn(3, "later"))
    expect(fixture.store.dueForDigest(minutes(1000), 60)).toEqual(["c1"])
  })
})
