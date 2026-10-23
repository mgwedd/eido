import { describe, expect, it } from "vitest"
import { PromptTooLargeError } from "../inference/errors"
import { compactConversation, summarizeTurns } from "./compact"
import {
  contentOf,
  stubModel,
  summarizingModel,
  turn,
  words,
} from "./conversation.test-support"

// Every turn below is 10 estimated tokens (30 characters) unless it says otherwise.
const ten = words(10)

describe("compactConversation: under the threshold", () => {
  it("returns the turns unchanged when at the threshold, with no model call", async () => {
    const turns = [turn(1, ten), turn(2, ten)]
    const model = summarizingModel()
    const result = await compactConversation(
      turns,
      { thresholdTokens: 20 },
      { queue: model.queue }
    )
    expect(result.compacted).toBe(false)
    expect(result.turns).toBe(turns)
    expect(result.error).toBeUndefined()
    expect(model.requests).toHaveLength(0)
  })

  it("compacts one token past the threshold", async () => {
    const turns = [turn(1, ten), turn(2, ten), turn(3, words(1))]
    const model = summarizingModel("S")
    const result = await compactConversation(
      turns,
      { thresholdTokens: 20, keepRecentTokens: 11 },
      { queue: model.queue }
    )
    expect(result.compacted).toBe(true)
  })
})

describe("compactConversation: keeping recent turns", () => {
  it("keeps the newest turns that fit keepRecentTokens, verbatim and in order, never splitting one", async () => {
    const turns = Array.from({ length: 8 }, (_, i) => turn(i + 1, ten))
    const model = summarizingModel("S")
    const result = await compactConversation(
      turns,
      { thresholdTokens: 50, keepRecentTokens: 25 },
      { queue: model.queue }
    )
    expect(result.compacted).toBe(true)
    // 25 tokens hold two whole 10-token turns, not two and a half.
    expect(result.turns.map((t) => t.id)).toEqual(["summary:t6", "t7", "t8"])
    expect(result.turns[1]).toBe(turns[6])
    expect(result.turns[2]).toBe(turns[7])
    expect(result.replacedTurns).toBe(6)
    expect(result.turns[0]).toMatchObject({ role: "summary", text: "S" })
  })

  it("sends only the replaced turns to the model", async () => {
    const turns = [
      turn(1, `old ${ten}`),
      turn(2, `mid ${ten}`),
      turn(3, `new ${ten}`),
    ]
    const model = summarizingModel("S")
    await compactConversation(
      turns,
      { thresholdTokens: 20, keepRecentTokens: 12 },
      { queue: model.queue }
    )
    const sent = contentOf(model.requests[0])
    expect(sent).toContain("old ")
    expect(sent).toContain("mid ")
    expect(sent).not.toContain("new ")
    expect(model.requests[0]?.jsonSchema).toMatchObject({
      required: ["summary"],
    })
  })

  it("replaces everything when no whole turn fits keepRecentTokens", async () => {
    const turns = [turn(1, ten), turn(2, ten)]
    const result = await compactConversation(
      turns,
      { thresholdTokens: 15, keepRecentTokens: 5 },
      { queue: summarizingModel("S").queue }
    )
    expect(result.turns.map((t) => t.role)).toEqual(["summary"])
    expect(result.replacedTurns).toBe(2)
  })

  it("reports an error when nothing is older than the kept turns", async () => {
    const turns = [turn(1, ten), turn(2, ten)]
    const model = summarizingModel("S")
    const result = await compactConversation(
      turns,
      { thresholdTokens: 15, keepRecentTokens: 100 },
      { queue: model.queue }
    )
    expect(result.compacted).toBe(false)
    expect(result.error?.kind).toBe("does_not_fit")
    expect(result.turns).toBe(turns)
    expect(model.requests).toHaveLength(0)
  })
})

describe("compactConversation: dates and source tags survive", () => {
  const replaced = [
    turn(1, "Lease signing is Oct 31 per [M3].", { sources: ["M3"] }),
    turn(2, "Rent review on 2025-11-02, see [M4].", {
      sources: ["M4"],
      at: "2025-10-13T09:00:00Z",
    }),
    turn(3, `Anything else from 3 November? ${words(30)}`, {
      at: "2025-10-12T09:00:00Z",
    }),
  ]
  const recent = turn(4, ten)
  const opts = { thresholdTokens: 60, keepRecentTokens: 10 }

  it("appends every date and tag a stubbed model left out, on a final line", async () => {
    const model = summarizingModel("They discussed the lease.")
    const result = await compactConversation([...replaced, recent], opts, {
      queue: model.queue,
    })
    const summary = result.turns[0]
    expect(summary?.text).toBe(
      "They discussed the lease.\nPreserved references: Oct 31; 2025-11-02; 3 November; M3; M4"
    )
    expect(result.preserved).toEqual({
      dates: ["Oct 31", "2025-11-02", "3 November"],
      tags: ["M3", "M4"],
    })
  })

  it("does not repeat what the model kept", async () => {
    const model = summarizingModel(
      "Lease on Oct 31 [M3]; review 2025-11-02 [M4]; asked about 3 November."
    )
    const result = await compactConversation([...replaced, recent], opts, {
      queue: model.queue,
    })
    expect(result.turns[0]?.text).not.toContain("Preserved references")
  })

  it("stamps the summary with the latest replaced timestamp and the union of tags", async () => {
    const result = await compactConversation([...replaced, recent], opts, {
      queue: summarizingModel().queue,
    })
    // The second turn is the latest in time even though it is not the last replaced turn.
    expect(result.turns[0]?.at).toBe("2025-10-13T09:00:00Z")
    expect(result.turns[0]?.sources).toEqual(["M3", "M4"])
  })

  it("keeps earlier preserved references when a summary is compacted again", async () => {
    const first = await compactConversation([...replaced, recent], opts, {
      queue: summarizingModel("First pass.").queue,
    })
    const more = [...first.turns, turn(5, words(20)), turn(6, words(20))]
    const second = await compactConversation(
      more,
      { thresholdTokens: 60, keepRecentTokens: 25 },
      { queue: summarizingModel("Second pass.").queue }
    )
    expect(second.compacted).toBe(true)
    const text = second.turns[0]?.text ?? ""
    for (const ref of ["Oct 31", "2025-11-02", "3 November", "M3", "M4"]) {
      expect(text).toContain(ref)
    }
    expect(second.turns[0]?.sources).toEqual(["M3", "M4"])
  })

  it("feeds the earlier summary to the model as older text", async () => {
    const first = await compactConversation([...replaced, recent], opts, {
      queue: summarizingModel("First pass.").queue,
    })
    const model = summarizingModel("Second pass.")
    await compactConversation(
      [...first.turns, turn(5, words(20)), turn(6, words(20))],
      { thresholdTokens: 60, keepRecentTokens: 25 },
      { queue: model.queue }
    )
    expect(contentOf(model.requests[0])).toContain(
      '[summary 2025-10-13T09:00:00Z]\n<material id="B" source="summary">\nFirst pass.'
    )
  })
})

describe("compactConversation: refuses rather than truncates", () => {
  it("returns an error naming the cause and every turn untouched when the result still does not fit", async () => {
    const turns = [turn(1, ten), turn(2, ten), turn(3, ten), turn(4, ten)]
    const model = summarizingModel(words(40))
    const result = await compactConversation(
      turns,
      { thresholdTokens: 30, keepRecentTokens: 10 },
      { queue: model.queue }
    )
    expect(result.compacted).toBe(false)
    expect(result.error?.kind).toBe("does_not_fit")
    expect(result.error?.message).toBe(
      "the summary and the recent turns need 50 tokens, over the 30 budget"
    )
    expect(result.turns).toBe(turns)
    expect(result.turns.map((t) => t.text)).toEqual([ten, ten, ten, ten])
  })
})

describe("compactConversation: model failures", () => {
  const turns = [turn(1, ten), turn(2, ten), turn(3, ten)]
  const opts = { thresholdTokens: 20, keepRecentTokens: 10 }

  it.each([
    [
      "a reply cut off at the length limit",
      stubModel(() => '{"summary":"x"}', "length"),
    ],
    ["text that is not JSON", stubModel(() => "plain words")],
    ["JSON without a summary", stubModel(() => '{"other":1}')],
    ["a blank summary", stubModel(() => '{"summary":"  "}')],
    ["JSON that is not an object", stubModel(() => "7")],
  ])(
    "reports %s as a model failure and returns the turns unchanged",
    async (_name, model) => {
      const result = await compactConversation(turns, opts, {
        queue: model.queue,
      })
      expect(result.compacted).toBe(false)
      expect(result.error).toEqual({
        kind: "model_failed",
        message: "the model did not return a complete summary",
      })
      expect(result.turns).toBe(turns)
    }
  )

  it("reports a refused oversize prompt instead of cutting it", async () => {
    const model = stubModel(() => {
      throw new PromptTooLargeError(5000, 6000, 4096)
    })
    const result = await compactConversation(turns, opts, {
      queue: model.queue,
    })
    expect(result.error?.kind).toBe("model_failed")
    expect(result.error?.message).toContain("prompt needs 6000 tokens")
    expect(result.turns).toBe(turns)
  })

  it("reports a thrown non-error value without a message", async () => {
    const model = stubModel(() => {
      // A plain string, as a misbehaving dependency might throw; JSON.parse types it as any.
      throw JSON.parse('"boom"')
    })
    const result = await compactConversation(turns, opts, {
      queue: model.queue,
    })
    expect(result.error?.message).toBe("the summary call failed: unknown error")
  })
})

describe("summarizeTurns: chunking", () => {
  it("folds older text into a running summary chunk by chunk without cutting a turn", async () => {
    const turns = [
      turn(1, `a ${ten}`),
      turn(2, `b ${ten}`),
      turn(3, `c ${ten}`),
    ]
    const model = stubModel((_req, call) =>
      JSON.stringify({ summary: `summary ${String(call)}` })
    )
    const result = await summarizeTurns(turns, { queue: model.queue }, 12)
    expect(model.requests).toHaveLength(3)
    const [first, second, third] = model.requests.map(
      (r) => contentOf(r)
    )
    expect(first).toBe(
      `[user 2025-10-11T09:00:00Z] a ${ten}\n\nSummarize the turns above.`
    )
    expect(second).toContain('Summary so far:\n<material id="B" source="summary">\nsummary 1\n</material id="B">')
    expect(second).toContain(`b ${ten}`)
    expect(second).not.toContain(`a ${ten}`)
    expect(third).toContain('Summary so far:\n<material id="B" source="summary">\nsummary 2\n</material id="B">')
    expect(result).toMatchObject({ ok: true, text: "summary 3" })
  })

  it("puts a turn larger than the chunk size in a chunk of its own", async () => {
    const model = summarizingModel("S")
    await summarizeTurns(
      [turn(1, words(30)), turn(2, ten)],
      { queue: model.queue },
      12
    )
    expect(model.requests).toHaveLength(2)
  })
})
