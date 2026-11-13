import { resolve } from "node:path"
import { describe, expect, test } from "vitest"
import { plainContent } from "../inference/fence"
import type { InferenceRequest, ModelClient } from "../inference/types"
import { ANSWER_REMINDER, ANSWER_SYSTEM } from "../ask/ask"
import {
  aggregate,
  buildAskRequest,
  loadAskCases,
  parseAskCase,
  parseAskCases,
  readTags,
  runAskEval,
  scoreAnswer,
} from "./ask-eval"
import type { AskEvalCase } from "./ask-eval"

const cases = loadAskCases(
  resolve(process.cwd(), "../../fixtures/eval/ask/cases.json")
)

function byId(id: string): AskEvalCase {
  const found = cases.find((c) => c.id === id)
  if (found === undefined) throw new Error(`no fixture case ${id}`)
  return found
}

function userText(request: InferenceRequest): string {
  const content = request.messages[0]?.content
  if (content === undefined || typeof content === "string")
    throw new Error("expected prompt parts")
  return plainContent(content, "b".repeat(32))
}

/** What a model that follows the rules answers for a case. */
function goodAnswer(testCase: AskEvalCase): string {
  if (testCase.kind === "no_match") return "No match found in the messages."
  const cites = testCase.sources.join(" ")
  const counts =
    testCase.placeholders.length === 0
      ? ""
      : ` There are ${testCase.placeholders.join(", ")} messages.`
  return `The answer is in the messages ${cites}.${counts}`.replace(
    /(\{\w+\}), /g,
    "$1 and "
  )
}

describe("fixture cases", () => {
  test("all twelve parse, ids are unique and every kind is covered", () => {
    expect(cases).toHaveLength(12)
    expect(new Set(cases.map((c) => c.id)).size).toBe(12)
    expect(cases.filter((c) => c.kind === "no_match").length).toBeGreaterThan(3)
    expect(cases.filter((c) => c.placeholders.length > 0).length).toBe(2)
  })

  test("the rule-following answer scores 100% on every case", () => {
    const scores = cases.map((c) => scoreAnswer(c, goodAnswer(c)))
    expect(aggregate(scores)).toEqual({
      tagCitation: 1,
      placeholderUse: 1,
      noMatchPhrasing: 1,
    })
  })

  test("a rule-breaking answer fails the check each case tests", () => {
    const bad = cases.map((c) =>
      scoreAnswer(c, "Three messages say it was fine.")
    )
    const scores = aggregate(bad)
    expect(scores.noMatchPhrasing).toBe(0)
    expect(scores.tagCitation).toBeCloseTo(4 / 12, 5)
  })
})

describe("parseAskCase", () => {
  const valid = {
    id: "x",
    question: "q?",
    kind: "answer",
    wants: "find",
    counts: { matched: 1, searched: 2, readInFull: 1 },
    messages: [{ tag: "[M1]", label: "mail", body: "hello" }],
    sources: ["[M1]"],
    placeholders: [],
  }

  test("accepts a valid case", () => {
    expect(parseAskCase(valid, "c").id).toBe("x")
  })

  test.each([
    ["not an object", 5, "c: expected an object"],
    [
      "bad kind",
      { ...valid, kind: "maybe" },
      "c.kind: expected answer or no_match",
    ],
    ["bad wants", { ...valid, wants: "x" }, "c.wants: expected count or find"],
    ["no counts", { ...valid, counts: 1 }, "c.counts: expected an object"],
    [
      "no messages",
      { ...valid, messages: [] },
      "c.messages: expected a non-empty array",
    ],
    [
      "message not an object",
      { ...valid, messages: [1] },
      "c.messages[0]: expected an object",
    ],
    [
      "bad tag",
      { ...valid, messages: [{ tag: "M1", label: "mail", body: "b" }] },
      "c.messages[0].tag: expected a tag like [M1]",
    ],
    [
      "unknown source",
      { ...valid, sources: ["[M9]"] },
      "c.sources: [M9] is not a message tag",
    ],
    [
      "answer without source",
      { ...valid, sources: [] },
      "c.sources: an answer case needs at least one source",
    ],
    [
      "no_match with source",
      { ...valid, kind: "no_match" },
      "c.sources: a no_match case has no source",
    ],
    [
      "bad placeholder",
      { ...valid, placeholders: ["{x}"] },
      "c.placeholders: {x} is not a placeholder",
    ],
    [
      "sources not array",
      { ...valid, sources: "x" },
      "c.sources: expected an array",
    ],
    ["empty id", { ...valid, id: "" }, "c.id: expected a non-empty string"],
    [
      "bad count",
      { ...valid, counts: { matched: -1, searched: 2, readInFull: 1 } },
      "c.counts.matched: expected a non-negative integer",
    ],
  ])("rejects %s", (_name, raw, message) => {
    expect(() => parseAskCase(raw, "c")).toThrow(message)
  })

  test("parseAskCases rejects an empty set and duplicate ids", () => {
    expect(() => parseAskCases({ cases: [] }, "s")).toThrow("at least one case")
    expect(() => parseAskCases({ cases: [valid, valid] }, "s")).toThrow(
      "duplicate case id x"
    )
  })
})

describe("buildAskRequest", () => {
  const testCase = byId("count-matches")

  test("with the reminder, the request ends as ask() ends it", () => {
    const request = buildAskRequest(testCase, true)
    const text = userText(request)
    expect(request.system).toBe(ANSWER_SYSTEM)
    expect(request.temperature).toBe(0)
    expect(
      text.endsWith(`Question: ${testCase.question}\n\n${ANSWER_REMINDER}`)
    ).toBe(true)
    expect(text).toContain("matched: 47")
    expect(text).toContain("wants: count")
    expect(text).toContain("[M1] mail")
    expect(text).toContain("[M2] mail")
  })

  test("without the reminder, only the reminder is missing", () => {
    const withReminder = userText(buildAskRequest(testCase, true))
    const without = userText(buildAskRequest(testCase, false))
    expect(without.endsWith(`Question: ${testCase.question}`)).toBe(true)
    expect(without).not.toContain(ANSWER_REMINDER)
    expect(withReminder.replace(`\n\n${ANSWER_REMINDER}`, "")).toBe(without)
  })

  test("a document message is labelled as a document", () => {
    expect(userText(buildAskRequest(byId("answer-document"), true))).toContain(
      "[M1] document"
    )
  })
})

describe("readTags", () => {
  test("reads well-formed tags in order", () => {
    expect(readTags("see [M2] and [M1].")).toEqual({
      cited: ["M2", "M1"],
      malformed: false,
    })
  })

  test.each([
    "see [M1, M2]",
    "see M1",
    "see (M1)",
    "see [Message 1]",
    "see [doc 2]",
  ])("flags %s as malformed", (answer) => {
    expect(readTags(answer).malformed).toBe(true)
  })
})

describe("scoreAnswer", () => {
  const answerCase = byId("answer-single")
  const noMatch = byId("no-match-unrelated")
  const counting = byId("count-matches")

  test("tag citation needs a real source and rejects invented or malformed tags", () => {
    expect(scoreAnswer(answerCase, "It is Thursday [M1].").tagCitation).toBe(
      true
    )
    expect(scoreAnswer(answerCase, "It is Thursday.").tagCitation).toBe(false)
    expect(scoreAnswer(answerCase, "It is Thursday [M2].").tagCitation).toBe(
      false
    )
    expect(
      scoreAnswer(answerCase, "It is Thursday [M1] [M9].").tagCitation
    ).toBe(false)
    expect(
      scoreAnswer(answerCase, "It is Thursday [M1, M2].").tagCitation
    ).toBe(false)
  })

  test("a no-match case needs no citation but still no invented tag", () => {
    expect(scoreAnswer(noMatch, "No match found.").tagCitation).toBe(true)
    expect(scoreAnswer(noMatch, "No match found [M7].").tagCitation).toBe(false)
  })

  test("placeholders must be written and no count of messages may be", () => {
    expect(
      scoreAnswer(counting, "{matches} match, I read {read} [M1].")
        .placeholderUse
    ).toBe(true)
    expect(
      scoreAnswer(counting, "{matches} match, and {read} read [M1].")
        .placeholderUse
    ).toBe(true)
    expect(scoreAnswer(counting, "{matches} match [M1].").placeholderUse).toBe(
      false
    )
    expect(
      scoreAnswer(counting, "47 matching messages, {matches} {read} [M1].")
        .placeholderUse
    ).toBe(false)
    expect(
      scoreAnswer(answerCase, "There are 1,284 messages [M1].").placeholderUse
    ).toBe(false)
    expect(
      scoreAnswer(answerCase, "On 14 May at 10:30 [M1].").placeholderUse
    ).toBe(true)
  })

  test("no-match phrasing needs the phrase and no claim of absence", () => {
    expect(scoreAnswer(noMatch, "No match found.").noMatchPhrasing).toBe(true)
    expect(scoreAnswer(noMatch, "Nothing relevant.").noMatchPhrasing).toBe(
      false
    )
    expect(
      scoreAnswer(noMatch, "No match found; it never happened.").noMatchPhrasing
    ).toBe(false)
    expect(
      scoreAnswer(answerCase, "No match found.").noMatchPhrasing
    ).toBeNull()
  })

  test("aggregate gives zero for a score with nothing to score", () => {
    expect(aggregate([])).toEqual({
      tagCitation: 0,
      placeholderUse: 0,
      noMatchPhrasing: 0,
    })
  })
})

describe("runAskEval", () => {
  /** Obeys the format only when the reminder is beside the question. */
  function reminderSensitiveModel(seen: InferenceRequest[]): ModelClient {
    return {
      complete(request) {
        seen.push(request)
        const text = userText(request)
        const id = cases.find((c) => text.includes(c.question))?.id ?? ""
        const testCase = byId(id)
        const answer = text.includes(ANSWER_REMINDER)
          ? goodAnswer(testCase)
          : "Three messages, it never happened."
        return Promise.resolve({
          text: answer,
          estimatedPromptTokens: 0,
          reportedPromptTokens: 0,
          truncationSuspected: false,
          finishReason: "stop",
        })
      },
    }
  }

  test("scores the two variants apart and sends the seed", async () => {
    const seen: InferenceRequest[] = []
    const client = reminderSensitiveModel(seen)
    const withReminder = await runAskEval({
      cases,
      client,
      variant: "with-reminder",
      seed: 7,
    })
    const without = await runAskEval({
      cases,
      client,
      variant: "without-reminder",
    })
    expect(withReminder.variant).toBe("with-reminder")
    expect(withReminder.scores).toEqual({
      tagCitation: 1,
      placeholderUse: 1,
      noMatchPhrasing: 1,
    })
    expect(without.scores.noMatchPhrasing).toBe(0)
    expect(without.scores.tagCitation).toBeLessThan(1)
    expect(withReminder.cases.map((c) => c.id)).toEqual(cases.map((c) => c.id))
    expect(seen.slice(0, 12).every((r) => r.seed === 7)).toBe(true)
    expect(seen.slice(12).every((r) => r.seed === undefined)).toBe(true)
  })
})
