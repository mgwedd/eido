import { describe, expect, test } from "vitest"
import {
  buildChatBody,
  canonicalize,
  promptText,
  serializeTools,
} from "./request"
import type { ToolDef } from "./types"

const tool: ToolDef = {
  type: "function",
  function: {
    name: "archive",
    description: "Archive a thread",
    parameters: { type: "object", properties: { id: { type: "string" } } },
  },
}

describe("canonicalize", () => {
  test("sorts object keys at every depth and keeps array order", () => {
    expect(
      JSON.stringify(canonicalize({ b: 1, a: [{ d: 2, c: 3 }, "x"] }))
    ).toBe('{"a":[{"c":3,"d":2},"x"],"b":1}')
  })
})

describe("promptText", () => {
  test("joins system, tools JSON and every message", () => {
    expect(
      promptText({
        system: "S",
        tools: [tool],
        messages: [
          { role: "user", content: "U" },
          { role: "assistant", content: "A" },
        ],
      })
    ).toBe(`S${serializeTools([tool])}UA`)
  })

  test("an empty tool list adds nothing", () => {
    expect(
      promptText({
        system: "S",
        tools: [],
        messages: [{ role: "user", content: "U" }],
      })
    ).toBe("SU")
  })
})

describe("buildChatBody", () => {
  test("writes tools, then the system message, then the variable fields", () => {
    expect(
      buildChatBody(
        {
          system: "S",
          tools: [tool],
          messages: [{ role: "user", content: "U" }],
          temperature: 0.2,
          seed: 7,
        },
        64
      )
    ).toBe(
      '{"tools":[{"function":{"description":"Archive a thread","name":"archive",' +
        '"parameters":{"properties":{"id":{"type":"string"}},"type":"object"}},"type":"function"}],' +
        '"messages":[{"role":"system","content":"S"},{"role":"user","content":"U"}],' +
        '"max_tokens":64,"temperature":0.2,"seed":7,"stream":true,' +
        '"stream_options":{"include_usage":true},"cache_prompt":true}'
    )
  })

  test("leaves out tools when the list is empty", () => {
    const body: unknown = JSON.parse(
      buildChatBody({ system: "S", tools: [], messages: [] }, 8)
    )
    expect(body).not.toHaveProperty("tools")
  })
})
