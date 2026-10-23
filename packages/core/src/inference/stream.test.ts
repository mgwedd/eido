import { describe, expect, test } from "vitest"
import { InferenceError } from "./errors"
import {
  applyEvent,
  finishStream,
  initialStreamState,
  splitEvents,
} from "./stream"

function run(events: string[]): ReturnType<typeof finishStream> {
  const state = initialStreamState()
  for (const event of events) applyEvent(state, event, 200)
  return finishStream(state, 200)
}

function failure(events: string[]): unknown {
  try {
    run(events)
  } catch (error) {
    return error
  }
  return undefined
}

const piece = (content: string): string =>
  `data: {"content":${JSON.stringify(content)},"stop":false}`
const final = (stopType: string, evaluated = 42): string =>
  `data: {"content":"","stop":true,"stop_type":"${stopType}","tokens_evaluated":${String(evaluated)}}`

describe("splitEvents", () => {
  test("returns complete events and keeps the unterminated rest", () => {
    expect(splitEvents("data: a\n\ndata: b\r\n\r\ndata: c")).toEqual({
      events: ["data: a", "data: b"],
      rest: "data: c",
    })
  })
})

describe("applyEvent and finishStream", () => {
  test("joins content and reads the finish and tokens_evaluated", () => {
    expect(run([piece("Hel"), piece("lo"), final("eos")])).toEqual({
      text: "Hello",
      finishReason: "stop",
      promptTokens: 42,
    })
  })

  test("skips comment and field lines", () => {
    expect(
      run([": keep-alive\nevent: message\n" + piece("x"), final("eos")]).text
    ).toBe("x")
  })

  test.each([
    ["eos", "stop"],
    ["word", "stop"],
    ["limit", "length"],
  ])("stop_type %s finishes as %s", (stopType, finishReason) => {
    expect(run([final(stopType)]).finishReason).toBe(finishReason)
  })

  test("a chunk without content still counts its stop flag", () => {
    expect(
      run([
        'data: {"stop":true,"stop_type":"eos","tokens_evaluated":7}',
      ]).promptTokens
    ).toBe(7)
  })

  test.each([
    ["a chunk that is not JSON", ["data: {oops"], "stream chunk is not JSON"],
    [
      "a chunk that is not an object",
      ["data: 3"],
      "stream chunk is not an object",
    ],
    [
      "a chunk without a stop flag",
      ['data: {"content":"x"}'],
      "stream chunk has no stop flag",
    ],
    [
      "content that is not a string",
      ['data: {"content":1,"stop":false}'],
      "stream chunk content is not a string",
    ],
    [
      "an unhandled stop type",
      ['data: {"stop":true,"stop_type":"none","tokens_evaluated":1}'],
      'stop_type "none" is not handled',
    ],
    [
      "a missing stop type",
      ['data: {"stop":true,"tokens_evaluated":1}'],
      "stop_type null is not handled",
    ],
    [
      "a final chunk without tokens_evaluated",
      ['data: {"stop":true,"stop_type":"eos"}'],
      "tokens_evaluated is missing or not a number",
    ],
    [
      "a server error with a message",
      ['data: {"error":{"message":"slot busy"}}'],
      "slot busy",
    ],
    [
      "a server error without a message",
      ['data: {"error":"x"}'],
      "server reported an error in the stream",
    ],
    [
      "data after the final chunk",
      [final("eos"), piece("late")],
      "data after the final chunk",
    ],
    [
      "a stream cut before the final chunk",
      [piece("partial")],
      "stream ended before the final chunk",
    ],
  ])("rejects %s as malformed", (_name, events, message) => {
    const error = failure(events)
    expect(error).toBeInstanceOf(InferenceError)
    expect(error).toMatchObject({ kind: "malformed", status: 200, message })
  })
})
