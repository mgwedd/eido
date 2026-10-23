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

const delta = (content: string): string =>
  `data: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":null}]}`
const stop = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'
const usage = 'data: {"choices":[],"usage":{"prompt_tokens":42}}'
const done = "data: [DONE]"

describe("splitEvents", () => {
  test("returns complete events and keeps the unterminated rest", () => {
    expect(splitEvents("data: a\n\ndata: b\r\n\r\ndata: c")).toEqual({
      events: ["data: a", "data: b"],
      rest: "data: c",
    })
  })
})

describe("applyEvent and finishStream", () => {
  test("joins deltas and reads finish reason and prompt tokens", () => {
    expect(run([delta("Hel"), delta("lo"), stop, usage, done])).toEqual({
      text: "Hello",
      finishReason: "stop",
      promptTokens: 42,
    })
  })

  test("skips comment and field lines", () => {
    expect(
      run([": keep-alive\nevent: message\n" + delta("x"), stop, usage, done])
        .text
    ).toBe("x")
  })

  test("reads a length finish", () => {
    expect(
      run([
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        usage,
        done,
      ]).finishReason
    ).toBe("length")
  })

  test.each([
    ["a chunk that is not JSON", ["data: {oops"], "stream chunk is not JSON"],
    [
      "a chunk that is not an object",
      ["data: 3"],
      "stream chunk is not an object",
    ],
    [
      "a chunk with neither choices nor usage",
      ["data: {}"],
      "stream chunk has neither choices nor usage",
    ],
    [
      "choices that are not an array",
      ['data: {"choices":1}'],
      "choices is not an array",
    ],
    [
      "a choice that is not an object",
      ['data: {"choices":[1]}'],
      "choice is not an object",
    ],
    [
      "usage without prompt tokens",
      ['data: {"choices":[],"usage":{}}'],
      "usage.prompt_tokens is missing or not a number",
    ],
    [
      "an unhandled finish reason",
      ['data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'],
      'finish_reason "tool_calls" is not handled',
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
      "data after [DONE]",
      [stop, usage, done, delta("late")],
      "data after [DONE]",
    ],
    ["a stream cut before [DONE]", [stop, usage], "stream ended before [DONE]"],
    [
      "a stream with no finish reason",
      [usage, done],
      "stream carried no finish_reason",
    ],
    [
      "a stream with no usage",
      [stop, done],
      "stream carried no usage.prompt_tokens",
    ],
  ])("rejects %s as malformed", (_name, events, message) => {
    const error = failure(events)
    expect(error).toBeInstanceOf(InferenceError)
    expect(error).toMatchObject({ kind: "malformed", status: 200, message })
  })

  test("a null usage is not a usage report", () => {
    expect(
      failure([stop, 'data: {"choices":[],"usage":null}', done])
    ).toMatchObject({
      message: "stream carried no usage.prompt_tokens",
    })
  })
})
