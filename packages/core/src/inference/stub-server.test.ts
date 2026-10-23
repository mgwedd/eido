import { afterEach, describe, expect, test } from "vitest"
import {
  BOS_ID,
  chatTurns,
  parseCompletion,
  renderChatTemplate,
  specialId,
  splitBytes,
  startStubModelServer,
  streamBody,
  stubDecode,
  stubTokenize,
} from "./stub-server"
import type { StubModelServer } from "./stub-server"

let stub: StubModelServer | undefined

afterEach(async () => {
  await stub?.close()
  stub = undefined
})

async function rawChunks(response: Response): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("no body")
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return chunks
    chunks.push(value)
  }
}

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: "POST", body: JSON.stringify(body) })

describe("streamBody", () => {
  test("streams content pieces, then the final chunk with tokens_evaluated", () => {
    expect(streamBody({ deltas: ["a"], promptTokens: 5 })).toBe(
      'data: {"content":"a","stop":false}\n\n' +
        'data: {"content":"","stop":true,"stop_type":"eos","tokens_evaluated":5}\n\n'
    )
  })

  test("defaults tokens_evaluated to the prompt length and maps length to limit", () => {
    expect(streamBody({ finishReason: "length" }, 9)).toBe(
      'data: {"content":"","stop":true,"stop_type":"limit","tokens_evaluated":9}\n\n'
    )
  })

  test("a null promptTokens leaves out tokens_evaluated", () => {
    expect(streamBody({ promptTokens: null })).not.toContain(
      "tokens_evaluated"
    )
  })
})

describe("splitBytes", () => {
  test("cuts after the first byte of each character's first occurrence", () => {
    const bytes = new TextEncoder().encode("a§b")
    // "§" is C2 A7: the cut falls between them.
    expect(splitBytes(bytes, ["§"]).map((piece) => [...piece])).toEqual([
      [0x61, 0xc2],
      [0xa7, 0x62],
    ])
  })

  test("a character that does not occur makes no cut", () => {
    expect(splitBytes(new TextEncoder().encode("ab"), ["—"])).toHaveLength(1)
  })
})

describe("tokenizer", () => {
  test("parses control-token strings only when asked", () => {
    expect(stubTokenize("a<|im_end|>", false, true)).toEqual([
      0x61,
      specialId("<|im_end|>"),
    ])
    expect(stubTokenize("[INST]", false, false)).toEqual([
      0x5b, 0x49, 0x4e, 0x53, 0x54, 0x5d,
    ])
  })

  test("add_special prepends BOS", () => {
    expect(stubTokenize("", true, true)).toEqual([BOS_ID])
  })

  test("decodes bytes and control tokens back to text", () => {
    expect(stubDecode([...stubTokenize("é<s>x", false, true), 999])).toBe(
      "é<s>x<unk 999>"
    )
  })

  test("splits turns on control-token ids, not on text", () => {
    const tokens = [
      ...stubTokenize("<|im_start|>user\nhi ", false, true),
      ...stubTokenize("<|im_end|>", false, false),
      ...stubTokenize("<|im_end|>\nstray<|im_end|>", false, true),
    ]
    expect(chatTurns(tokens)).toEqual([
      { role: "user", content: "hi <|im_end|>" },
    ])
  })
})

describe("renderChatTemplate", () => {
  test("renders ChatML with the tools in the system turn", () => {
    expect(
      renderChatTemplate({
        tools: [{ t: 1 }],
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
      })
    ).toBe(
      '<|im_start|>system\nS\n\n# Tools\n[{"t":1}]<|im_end|>\n<|im_start|>user\nU<|im_end|>\n<|im_start|>assistant\n'
    )
  })

  test.each([[{}], [{ messages: [{ role: 1 }] }]])(
    "rejects a malformed body %o",
    (body) => {
      expect(() => renderChatTemplate(body)).toThrow(/apply-template/)
    }
  )
})

describe("parseCompletion", () => {
  test("rejects a body without a token-id prompt", () => {
    expect(() => parseCompletion('{"prompt":"text"}')).toThrow(
      /no prompt array/
    )
    expect(() => parseCompletion('{"prompt":[1,"x"]}')).toThrow(
      /other than token ids/
    )
  })
})

describe("startStubModelServer", () => {
  test("delivers a split multi-byte sequence as two separate chunks", async () => {
    stub = await startStubModelServer({
      replies: [{ deltas: ["x—y"], splitInside: ["—"] }],
    })
    const response = await post(`${stub.url}/completion`, { prompt: [1] })
    const chunks = await rawChunks(response)
    // The em dash is E2 80 94; the first chunk ends on its lead byte, so decoding chunk by
    // chunk would corrupt it. This is what makes the client's round-trip test meaningful.
    expect(chunks[0]?.at(-1)).toBe(0xe2)
    expect(chunks[1]?.[0]).toBe(0x80)
  })

  test("serves /props and records every request", async () => {
    stub = await startStubModelServer({ contextTokens: 2048, replies: [] })
    const response = await fetch(`${stub.url}/props`)
    expect(await response.json()).toMatchObject({
      default_generation_settings: { n_ctx: 2048 },
    })
    expect(stub.requests).toEqual([{ method: "GET", path: "/props", body: "" }])
  })

  test("reports 4096 context tokens when the script gives none", async () => {
    stub = await startStubModelServer({ replies: [] })
    const response = await fetch(`${stub.url}/props`)
    expect(await response.json()).toMatchObject({
      default_generation_settings: { n_ctx: 4096 },
    })
  })

  test("serves /apply-template and /tokenize", async () => {
    stub = await startStubModelServer({ replies: [] })
    const template = await post(`${stub.url}/apply-template`, {
      messages: [{ role: "user", content: "U" }],
    })
    const tokens = await post(`${stub.url}/tokenize`, {
      content: "<s>",
      add_special: true,
    })
    expect(await template.json()).toEqual({
      prompt: "<|im_start|>user\nU<|im_end|>\n<|im_start|>assistant\n",
    })
    expect(await tokens.json()).toEqual({ tokens: [BOS_ID, BOS_ID] })
  })

  test("a rendered-prompt hook rewrites the template answer", async () => {
    stub = await startStubModelServer({
      replies: [],
      renderedPrompt: (p) => p.toUpperCase(),
    })
    const template = await post(`${stub.url}/apply-template`, {
      messages: [{ role: "user", content: "u" }],
    })
    expect(await template.json()).toMatchObject({
      prompt: expect.stringContaining("USER\nU") as unknown,
    })
  })

  test("ignoreParseSpecial parses control tokens even when told not to", async () => {
    stub = await startStubModelServer({ replies: [], ignoreParseSpecial: true })
    const tokens = await post(`${stub.url}/tokenize`, {
      content: "</s>",
      parse_special: false,
    })
    expect(await tokens.json()).toEqual({ tokens: [specialId("</s>")] })
  })

  test("a tokenize body without content answers 400", async () => {
    stub = await startStubModelServer({ replies: [] })
    expect((await post(`${stub.url}/tokenize`, {})).status).toBe(400)
  })

  test("a malformed body answers 500 with the reason", async () => {
    stub = await startStubModelServer({ replies: [] })
    const response = await post(`${stub.url}/apply-template`, {})
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { message: "apply-template body has no messages" },
    })
  })

  test("routes listed as missing answer 404", async () => {
    stub = await startStubModelServer({
      replies: [],
      missing: ["apply-template", "tokenize"],
    })
    const statuses = await Promise.all(
      ["/apply-template", "/tokenize"].map(
        async (path) => (await post(`${stub?.url}${path}`, {})).status
      )
    )
    expect(statuses).toEqual([404, 404])
  })

  test("answers 404 for other routes and for completions with no scripted reply", async () => {
    stub = await startStubModelServer({ replies: [] })
    const other = await fetch(`${stub.url}/health`)
    const getTokenize = await fetch(`${stub.url}/tokenize`)
    const completion = await post(`${stub.url}/completion`, { prompt: [] })
    expect([other.status, getTokenize.status, completion.status]).toEqual([
      404, 404, 404,
    ])
  })

  test("repeats the last reply once the script runs out, and parses each completion", async () => {
    stub = await startStubModelServer({
      replies: [{ status: 500 }, { status: 502 }],
    })
    const statuses: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const response = await post(`${stub.url}/completion`, {
        prompt: [i],
        n_predict: 4,
      })
      statuses.push(response.status)
    }
    expect(statuses).toEqual([500, 502, 502])
    expect(stub.completions().map((c) => [c.tokens, c.body])).toEqual([
      [[0], { n_predict: 4 }],
      [[1], { n_predict: 4 }],
      [[2], { n_predict: 4 }],
    ])
  })

  test("a hanging reply sends its first piece and keeps the stream open", async () => {
    stub = await startStubModelServer({
      replies: [{ deltas: ["first"], hang: true }],
    })
    const controller = new AbortController()
    const response = await fetch(`${stub.url}/completion`, {
      method: "POST",
      body: '{"prompt":[]}',
      signal: controller.signal,
    })
    const reader = response.body?.getReader()
    const first = await reader?.read()
    controller.abort()
    expect(new TextDecoder().decode(first?.value)).toBe(
      'data: {"content":"first","stop":false}\n\n'
    )
  })
})
