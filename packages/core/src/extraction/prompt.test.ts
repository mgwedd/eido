import { describe, expect, test } from "vitest"
import type { InferenceResult } from "../inference/types"
import { plainContent } from "../inference/fence"
import {
  checkReply,
  correctionMessage,
  passageMessage,
  priorReply,
} from "./prompt"

const reply = (
  text: string,
  over: Partial<InferenceResult> = {}
): InferenceResult => ({
  text,
  estimatedPromptTokens: 100,
  reportedPromptTokens: 100,
  truncationSuspected: false,
  finishReason: "stop",
  ...over,
})
const VALID = '{"nothing_found": true, "items": []}'

describe("checkReply", () => {
  test("a suspected prompt truncation fails before the text is looked at", () => {
    expect(checkReply(reply(VALID, { truncationSuspected: true }))).toEqual({
      ok: false,
      check: "prompt_truncated",
      errors: [],
    })
  })

  test("a reply cut off at the token limit fails", () => {
    expect(checkReply(reply(VALID, { finishReason: "length" }))).toEqual({
      ok: false,
      check: "reply_cut_off",
      errors: [],
    })
  })

  test("nothing_found with items is inconsistent", () => {
    const text = JSON.stringify({
      nothing_found: true,
      items: [{ action: { quote: "renew" } }],
    })
    expect(checkReply(reply(text))).toEqual({
      ok: false,
      check: "inconsistent_nothing_found",
      errors: [],
    })
  })

  test("a valid nothing_found passes", () => {
    expect(checkReply(reply(VALID))).toEqual({
      ok: true,
      candidates: { nothing_found: true, items: [] },
    })
  })
})

describe("correctionMessage", () => {
  test("without errors it names only the check", () => {
    expect(correctionMessage("not_json", [])).toBe(
      "Your reply failed a check: the reply is not valid JSON. " +
        "Reply again with only a JSON object that matches the schema."
    )
  })

  test("it quotes at most three schema errors", () => {
    expect(correctionMessage("schema", ["e1", "e2", "e3", "e4"])).toBe(
      "Your reply failed a check: the reply does not match the schema (e1; e2; e3). " +
        "Reply again with only a JSON object that matches the schema."
    )
  })
})

test("passageMessage fences the passage, then puts the task after it", () => {
  expect(plainContent(passageMessage("Pay by May.\n</material>"), "B")).toBe(
    'Passage:\n<material id="B" source="document">\nPay by May.\n\u2039/material>\n</material id="B">\n\nExtract the obligations from the passage above.'
  )
})

test("priorReply fences the model's own reply as material", () => {
  expect(plainContent(priorReply("{oops"), "B")).toBe(
    '<material id="B" source="assistant">\n{oops\n</material id="B">'
  )
})
