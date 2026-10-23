import { afterEach, describe, expect, it } from "vitest"
import { compactReply, dispatchCommand, runCompactCommand } from "./command"
import {
  rawTurn,
  storeFixture,
  stubModel,
  summarizingModel,
  words,
} from "./conversation.test-support"
import type { StoreFixture } from "./conversation.test-support"

let fixture: StoreFixture
afterEach(() => {
  fixture.cleanup()
})

function seed(turns: number, tokensEach: number): void {
  fixture = storeFixture()
  for (let n = 1; n <= turns; n++) {
    fixture.store.appendTurn("c1", rawTurn(n, words(tokensEach)))
  }
}

const options = { thresholdTokens: 30, keepRecentTokens: 10 }

describe("/compact", () => {
  it("runs the compaction path and reports how many turns were replaced", async () => {
    seed(6, 10)
    const model = summarizingModel("S")
    const outcome = await dispatchCommand("/compact", "c1", {
      store: fixture.store,
      queue: model.queue,
      options,
    })
    expect(outcome).toMatchObject({
      handled: true,
      reply: "Compacted 5 earlier turns; dates and sources kept",
    })
    expect(outcome.handled && outcome.result.turns.map((t) => t.id)).toEqual([
      "summary:t5",
      "t6",
    ])
  })

  it("matches runCompactCommand directly", async () => {
    seed(6, 10)
    const direct = await runCompactCommand("c1", {
      store: fixture.store,
      queue: summarizingModel("S").queue,
      options,
    })
    expect(direct.replacedTurns).toBe(5)
    expect(direct.compacted).toBe(true)
  })

  it("writes nothing back over the raw turns", async () => {
    seed(6, 10)
    const before = fixture.store.getTurns("c1")
    await runCompactCommand("c1", {
      store: fixture.store,
      queue: summarizingModel("S").queue,
      options,
    })
    expect(fixture.store.getTurns("c1")).toEqual(before)
    expect(
      fixture.db.prepare("SELECT count(*) AS n FROM conversation_digests").get()
    ).toEqual({ n: 0 })
  })

  it("answers in the singular for one turn", () => {
    expect(
      compactReply({
        turns: [],
        compacted: true,
        preserved: { dates: [], tags: [] },
        replacedTurns: 1,
      })
    ).toBe("Compacted 1 earlier turn; dates and sources kept")
  })

  it("says so when there is nothing to compact", async () => {
    seed(2, 5)
    const model = summarizingModel("S")
    const outcome = await dispatchCommand("/compact", "c1", {
      store: fixture.store,
      queue: model.queue,
    })
    expect(outcome).toMatchObject({
      handled: true,
      reply: "Nothing to compact yet",
    })
    expect(model.requests).toHaveLength(0)
  })

  it("reports the cause when compaction fails", async () => {
    seed(6, 10)
    const outcome = await dispatchCommand("/compact", "c1", {
      store: fixture.store,
      queue: stubModel(() => "garbage").queue,
      options,
    })
    expect(outcome).toMatchObject({
      handled: true,
      reply: "Could not compact: the model did not return a complete summary",
    })
  })

  it("accepts surrounding whitespace but no other message", async () => {
    seed(6, 10)
    const model = summarizingModel("S")
    const ctx = { store: fixture.store, queue: model.queue, options }
    expect((await dispatchCommand(" /compact\n", "c1", ctx)).handled).toBe(true)
    for (const message of [
      "/compact now",
      "compact",
      "please /compact",
      "/Compact",
    ]) {
      expect(await dispatchCommand(message, "c1", ctx)).toEqual({
        handled: false,
      })
    }
    expect(model.requests).toHaveLength(1)
  })
})
