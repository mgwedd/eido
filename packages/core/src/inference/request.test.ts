import { describe, expect, test } from "vitest"
import { fence, toMaterial } from "./fence"
import {
  buildCompletionBody,
  buildTemplateBody,
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
      promptText(
        {
          system: "S",
          tools: [tool],
          messages: [
            { role: "user", content: "U" },
            { role: "assistant", content: "A" },
          ],
        },
        "b"
      )
    ).toBe(`S${serializeTools([tool])}UA`)
  })

  test("an empty tool list adds nothing", () => {
    expect(
      promptText(
        { system: "S", tools: [], messages: [{ role: "user", content: "U" }] },
        "b"
      )
    ).toBe("SU")
  })

  test("counts a fenced block as the model reads it", () => {
    const block = fence(toMaterial("body", { source: "document" }))
    expect(
      promptText(
        { system: "", messages: [{ role: "user", content: ["Q ", block] }] },
        "b1"
      )
    ).toBe('Q <material id="b1" source="document">\nbody\n</material id="b1">')
  })
})

describe("buildTemplateBody", () => {
  test("writes tools, then the system message, with each span replaced", () => {
    const block = fence(
      toMaterial("hello", { source: "mail", from: "ann@example.invalid" })
    )
    let n = 0
    expect(
      buildTemplateBody(
        {
          system: "S",
          tools: [tool],
          messages: [{ role: "user", content: [block, "Q"] }],
        },
        "b",
        () => `#${String(n++)}`
      )
    ).toBe(
      '{"tools":[{"function":{"description":"Archive a thread","name":"archive",' +
        '"parameters":{"properties":{"id":{"type":"string"}},"type":"object"}},"type":"function"}],' +
        '"messages":[{"role":"system","content":"S"},' +
        '{"role":"user","content":"<material id=\\"b\\" source=\\"mail\\" from=\\"#0\\">\\n#1\\n</material id=\\"b\\">Q"}]}'
    )
  })

  test("leaves out tools when the list is empty", () => {
    const body: unknown = JSON.parse(
      buildTemplateBody({ system: "S", tools: [], messages: [] }, "b", (s) => s)
    )
    expect(body).not.toHaveProperty("tools")
  })
})

describe("buildCompletionBody", () => {
  test("sends token ids, the reply cap, sampling, the schema, streaming and cache_prompt", () => {
    expect(
      buildCompletionBody(
        {
          system: "S",
          messages: [],
          temperature: 0.2,
          seed: 7,
          jsonSchema: { type: "object", properties: {} },
        },
        [1, 2, 3],
        64
      )
    ).toBe(
      '{"prompt":[1,2,3],"n_predict":64,"temperature":0.2,"seed":7,' +
        '"json_schema":{"properties":{},"type":"object"},"stream":true,"cache_prompt":true}'
    )
  })

  test("without a schema, temperature or seed those keys are left out", () => {
    const body: unknown = JSON.parse(
      buildCompletionBody({ system: "S", messages: [] }, [1], 8)
    )
    expect(Object.keys(body as object)).toEqual([
      "prompt",
      "n_predict",
      "stream",
      "cache_prompt",
    ])
  })

  test("uses the non-streaming probability response only when requested", () => {
    const body: unknown = JSON.parse(
      buildCompletionBody(
        { system: "S", messages: [], includeTokenProbabilities: true },
        [1],
        8
      )
    )
    expect(body).toMatchObject({
      stream: false,
      n_probs: 1,
    })
  })
})
