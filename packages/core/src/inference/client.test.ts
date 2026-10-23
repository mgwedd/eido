import { afterEach, describe, expect, test } from "vitest"
import * as core from "../index"
import { createModelClient, loopbackBaseUrl, readContextTokens } from "./client"
import { InferenceError, PromptTooLargeError } from "./errors"
import { startStubModelServer } from "./stub-server"
import type { StubModelServer, StubScript } from "./stub-server"
import type { ModelServerConfig, ToolDef } from "./types"

// Every case runs against the stub server on 127.0.0.1: no model, no network, synthetic text.

let stub: StubModelServer | undefined

afterEach(async () => {
  await stub?.close()
  stub = undefined
})

async function start(script: StubScript): Promise<StubModelServer> {
  stub = await startStubModelServer(script)
  return stub
}

function config(
  server: StubModelServer,
  overrides: Partial<ModelServerConfig> = {}
): ModelServerConfig {
  return {
    baseUrl: server.url,
    contextTokens: 4096,
    maxReplyTokens: 100,
    ...overrides,
  }
}

/** A user message of `tokens` estimated tokens (three characters each). */
function userOf(tokens: number): { role: "user"; content: string } {
  return { role: "user", content: "abc".repeat(tokens) }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected the promise to reject")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function bodyOf(
  server: StubModelServer,
  index: number
): Record<string, unknown> {
  const raw = server.requests[index]?.body
  if (raw === undefined) throw new Error(`no request ${String(index)}`)
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) throw new Error("body is not an object")
  return parsed
}

test("the core entry point exports the client", () => {
  expect(core.createModelClient).toBe(createModelClient)
})

describe("refuse, don't truncate", () => {
  test("an oversized prompt throws with the three numbers and sends nothing", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    const client = createModelClient(config(server, { contextTokens: 1100 }))
    const error = await rejection(
      client.complete({ system: "", messages: [userOf(901)] })
    )
    expect(error).toBeInstanceOf(PromptTooLargeError)
    expect(error).toMatchObject({
      estimatedPromptTokens: 901,
      requiredTokens: 1102,
      contextTokens: 1100,
    })
    expect(server.requests).toHaveLength(0)
  })

  test("a prompt exactly at the limit is sent", async () => {
    const server = await start({
      replies: [{ deltas: ["ok"], promptTokens: 900 }],
    })
    const client = createModelClient(config(server, { contextTokens: 1100 }))
    const result = await client.complete({
      system: "",
      messages: [userOf(900)],
    })
    expect(result.estimatedPromptTokens).toBe(900)
    expect(result.text).toBe("ok")
  })

  test("a prompt one token over the limit is refused", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    const client = createModelClient(config(server, { contextTokens: 1100 }))
    await expect(
      client.complete({ system: "a", messages: [userOf(900)] })
    ).rejects.toBeInstanceOf(PromptTooLargeError)
  })

  test("the estimate covers the system prompt and tools as well as messages", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    const client = createModelClient(config(server))
    const tools: ToolDef[] = [{ type: "function", function: { name: "t" } }]
    // System "abc", the tools JSON [{"function":{"name":"t"},"type":"function"}] (45 characters)
    // and "abc": 51 characters, 17 tokens. Messages alone would be 1.
    const result = await client.complete({
      system: "abc",
      tools,
      messages: [userOf(1)],
    })
    expect(result.estimatedPromptTokens).toBe(17)
  })

  test("a request's maxTokens replaces the reply reservation", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    const client = createModelClient(config(server, { contextTokens: 1100 }))
    // 990 + 10 = 1000 tokens, 1100 with the margin: fits only because of maxTokens.
    await client.complete({
      system: "",
      messages: [userOf(990)],
      maxTokens: 10,
    })
    expect(bodyOf(server, 0).max_tokens).toBe(10)
  })
})

describe("truncation tripwire", () => {
  test("fires when the server reports under 60% of an estimate over 500", async () => {
    const server = await start({
      replies: [{ deltas: ["ok"], promptTokens: 599 }],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1000)],
    })
    expect(result).toMatchObject({
      estimatedPromptTokens: 1000,
      reportedPromptTokens: 599,
      truncationSuspected: true,
    })
  })

  test("does not fire at exactly 60%", async () => {
    const server = await start({
      replies: [{ deltas: ["ok"], promptTokens: 600 }],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1000)],
    })
    expect(result.truncationSuspected).toBe(false)
  })

  test("does not fire at an estimate of 500, whatever the server reports", async () => {
    const server = await start({
      replies: [{ deltas: ["ok"], promptTokens: 0 }],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(500)],
    })
    expect(result.truncationSuspected).toBe(false)
  })

  test("takes its ratio and minimum from config", async () => {
    const server = await start({
      replies: [{ deltas: ["ok"], promptTokens: 80 }],
    })
    const client = createModelClient(
      config(server, { tripwireRatio: 0.9, tripwireMinPromptTokens: 50 })
    )
    const result = await client.complete({
      system: "",
      messages: [userOf(100)],
    })
    expect(result.truncationSuspected).toBe(true)
  })
})

describe("streaming", () => {
  const reply = "Section § says “quoted” and ‘single’ — then stops."

  test("a reply split inside multi-byte sequences decodes intact", async () => {
    const server = await start({
      replies: [
        {
          deltas: [reply],
          promptTokens: 10,
          splitInside: ["§", "“", "’", "—"],
        },
      ],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(3)],
    })
    expect(result.text).toBe(reply)
  })

  test("deltas are joined in order and the finish reason is passed through", async () => {
    const server = await start({
      replies: [{ deltas: ["one ", "two"], finishReason: "length" }],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(3)],
    })
    expect(result).toMatchObject({ text: "one two", finishReason: "length" })
  })
})

describe("request body", () => {
  const toolA: ToolDef = {
    type: "function",
    function: {
      name: "archive",
      parameters: { type: "object", required: ["id"] },
    },
  }
  // The same tool with its keys written in another order.
  const toolB: ToolDef = {
    function: {
      parameters: { required: ["id"], type: "object" },
      name: "archive",
    },
    type: "function",
  }

  test("equal system prompt and tools give byte-identical prefixes and cache_prompt", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    const client = createModelClient(config(server))
    await client.complete({
      system: "Be brief.",
      tools: [toolA],
      messages: [userOf(2)],
    })
    await client.complete({
      system: "Be brief.",
      tools: [toolB],
      messages: [{ role: "user", content: "different" }],
      temperature: 0,
    })
    const prefix =
      '{"tools":[{"function":{"name":"archive","parameters":{"required":["id"],"type":"object"}},' +
      '"type":"function"}],"messages":[{"role":"system","content":"Be brief."}'
    expect(server.requests.map((r) => r.body.startsWith(prefix))).toEqual([
      true,
      true,
    ])
    expect([
      bodyOf(server, 0).cache_prompt,
      bodyOf(server, 1).cache_prompt,
    ]).toEqual([true, true])
  })

  test("sends to the chat completions route with streaming and usage on", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
    })
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/chat/completions",
    })
    expect(bodyOf(server, 0)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 100,
    })
  })

  test("with jsonSchema the schema is sent under response_format", async () => {
    const server = await start({ replies: [{ deltas: ["{}"] }] })
    const schema = { type: "object", properties: { ok: { type: "boolean" } } }
    await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
      jsonSchema: schema,
    })
    expect(bodyOf(server, 0).response_format).toEqual({
      type: "json_schema",
      json_schema: { schema },
    })
  })

  test("without jsonSchema there is no response_format key", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
    })
    expect(bodyOf(server, 0)).not.toHaveProperty("response_format")
  })
})

describe("configuration", () => {
  test.each([
    "http://203.0.113.5:8080",
    "http://localhost.example.invalid:8080",
    "http://[::2]:1",
  ])("a non-loopback baseUrl %s throws at construction", (baseUrl) => {
    expect(() =>
      createModelClient({ baseUrl, contextTokens: 4096, maxReplyTokens: 100 })
    ).toThrow(/must be 127\.0\.0\.1, ::1 or localhost/)
  })

  test("loopback hosts are accepted and a trailing slash is dropped", () => {
    expect(
      [
        "http://127.0.0.1:8080/",
        "http://[::1]:8080",
        "https://localhost:8080//",
      ].map(loopbackBaseUrl)
    ).toEqual([
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
      "https://localhost:8080",
    ])
  })

  test("a baseUrl that is not a URL throws", () => {
    expect(() => loopbackBaseUrl("127.0.0.1:8080/x y")).toThrow(/is not a URL/)
  })

  test("a non-http scheme throws", () => {
    expect(() => loopbackBaseUrl("ftp://127.0.0.1/")).toThrow(/http or https/)
  })

  test.each([
    [{ contextTokens: 0 }, /contextTokens must be a positive number/],
    [
      { maxReplyTokens: Number.NaN },
      /maxReplyTokens must be a positive number/,
    ],
    [{ charsPerToken: -1 }, /charsPerToken must be a positive number/],
    [{ marginRatio: 1.5 }, /marginRatio must be between 0 and 1/],
    [{ tripwireRatio: -0.1 }, /tripwireRatio must be between 0 and 1/],
  ])("rejects %o", (overrides, message) => {
    expect(() =>
      createModelClient({
        baseUrl: "http://127.0.0.1:1",
        contextTokens: 4096,
        maxReplyTokens: 100,
        ...overrides,
      })
    ).toThrow(message)
  })
})

describe("errors", () => {
  test("a non-2xx answer rejects with its status and is not retried", async () => {
    const server = await start({
      replies: [{ status: 503 }, { deltas: ["ok"] }],
    })
    const error = await rejection(
      createModelClient(config(server)).complete({
        system: "",
        messages: [userOf(1)],
      })
    )
    expect(error).toBeInstanceOf(InferenceError)
    expect(error).toMatchObject({ kind: "http", status: 503 })
    expect(server.requests).toHaveLength(1)
  })

  test("aborting mid-stream rejects as aborted and is not retried", async () => {
    const server = await start({
      replies: [{ deltas: ["partial"], hang: true }],
    })
    const controller = new AbortController()
    const pending = createModelClient(config(server)).complete(
      { system: "", messages: [userOf(1)] },
      { signal: controller.signal }
    )
    setTimeout(() => controller.abort(), 50)
    const error = await rejection(pending)
    expect(error).toBeInstanceOf(InferenceError)
    expect(error).toMatchObject({ kind: "aborted", status: null })
    expect(server.requests).toHaveLength(1)
  })

  test("an already-aborted signal rejects as aborted", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    const error = await rejection(
      createModelClient(config(server)).complete(
        { system: "", messages: [userOf(1)] },
        { signal: AbortSignal.abort() }
      )
    )
    expect(error).toMatchObject({ kind: "aborted" })
  })

  test("a malformed stream rejects with the response status", async () => {
    const server = await start({ replies: [{ rawBody: "data: {oops\n\n" }] })
    const error = await rejection(
      createModelClient(config(server)).complete({
        system: "",
        messages: [userOf(1)],
      })
    )
    expect(error).toMatchObject({ kind: "malformed", status: 200 })
  })

  test("a final event without a trailing blank line is still read", async () => {
    const server = await start({
      replies: [
        {
          rawBody:
            'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],' +
            '"usage":{"prompt_tokens":3}}\n\ndata: [DONE]',
        },
      ],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
    })
    expect(result).toMatchObject({ text: "hi", reportedPromptTokens: 3 })
  })

  test("invalid UTF-8 in the stream rejects as malformed", async () => {
    const fetchBadBytes: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new Uint8Array([
            0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a,
          ]),
          {
            status: 200,
          }
        )
      )
    const client = createModelClient(
      {
        baseUrl: "http://127.0.0.1:1",
        contextTokens: 4096,
        maxReplyTokens: 100,
      },
      { fetch: fetchBadBytes }
    )
    const error = await rejection(
      client.complete({ system: "", messages: [userOf(1)] })
    )
    expect(error).toMatchObject({
      kind: "malformed",
      message: "could not read the stream",
    })
  })

  test("a response with no body rejects as malformed", async () => {
    const client = createModelClient(
      {
        baseUrl: "http://127.0.0.1:1",
        contextTokens: 4096,
        maxReplyTokens: 100,
      },
      { fetch: () => Promise.resolve(new Response(null, { status: 200 })) }
    )
    const error = await rejection(
      client.complete({ system: "", messages: [userOf(1)] })
    )
    expect(error).toMatchObject({
      kind: "malformed",
      message: "response has no body",
    })
  })

  test("a server that is not listening rejects as unreachable", async () => {
    const server = await start({ replies: [] })
    const { url } = server
    await server.close()
    stub = undefined
    const client = createModelClient({
      baseUrl: url,
      contextTokens: 4096,
      maxReplyTokens: 100,
    })
    const error = await rejection(
      client.complete({ system: "", messages: [userOf(1)] })
    )
    expect(error).toMatchObject({ kind: "unreachable", status: null })
  })
})

describe("readContextTokens", () => {
  test("reads n_ctx from /props", async () => {
    const server = await start({ contextTokens: 8192, replies: [] })
    expect(await readContextTokens(server.url)).toBe(8192)
    expect(server.requests[0]).toMatchObject({ method: "GET", path: "/props" })
  })

  test("refuses a non-loopback baseUrl", async () => {
    await expect(readContextTokens("http://203.0.113.5:8080")).rejects.toThrow(
      /must be 127\.0\.0\.1/
    )
  })

  const respond =
    (response: Response): typeof fetch =>
    () =>
      Promise.resolve(response)

  test.each([
    [
      "a non-2xx answer",
      new Response("{}", { status: 503 }),
      { kind: "http", status: 503 },
    ],
    [
      "a body that is not JSON",
      new Response("nope"),
      { kind: "malformed", message: "props is not JSON" },
    ],
    [
      "props without n_ctx",
      new Response(JSON.stringify({ default_generation_settings: {} })),
      { kind: "malformed", status: 200 },
    ],
    [
      "a zero n_ctx",
      new Response(
        JSON.stringify({ default_generation_settings: { n_ctx: 0 } })
      ),
      { kind: "malformed" },
    ],
    [
      "props that are not an object",
      new Response("[1]"),
      { kind: "malformed" },
    ],
  ])("rejects %s", async (_name, response, expected) => {
    const error = await rejection(
      readContextTokens("http://127.0.0.1:1", { fetch: respond(response) })
    )
    expect(error).toBeInstanceOf(InferenceError)
    expect(error).toMatchObject(expected)
  })

  test("an already-aborted signal rejects as aborted", async () => {
    const server = await start({ replies: [] })
    const error = await rejection(
      readContextTokens(server.url, { signal: AbortSignal.abort() })
    )
    expect(error).toMatchObject({ kind: "aborted" })
  })

  test("a server that is not listening rejects as unreachable", async () => {
    const server = await start({ replies: [] })
    const { url } = server
    await server.close()
    stub = undefined
    const error = await rejection(readContextTokens(url))
    expect(error).toMatchObject({ kind: "unreachable" })
  })
})
