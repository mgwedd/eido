import { afterEach, describe, expect, test } from "vitest"
import * as core from "../index"
import {
  connectModelClient,
  createModelClient,
  loopbackBaseUrl,
  placeholder,
  readContextTokens,
  readModelId,
  splitRendered,
} from "./client"
import {
  InferenceError,
  PromptTooLargeError,
  UnsupportedModelServerError,
} from "./errors"
import { fence, toMaterial } from "./fence"
import { BOS_ID, startStubModelServer, stubDecode } from "./stub-server"
import type { CompletionView, StubModelServer, StubScript } from "./stub-server"
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

function completion(server: StubModelServer, index: number): CompletionView {
  const view = server.completions()[index]
  if (view === undefined) throw new Error(`no completion ${String(index)}`)
  return view
}

/** The body of the `index`th request to `path`. */
function bodyAt(
  server: StubModelServer,
  path: string,
  index = 0
): Record<string, unknown> {
  const raw = server.requests.filter((r) => r.path === path)[index]?.body
  if (raw === undefined) throw new Error(`no ${path} request ${String(index)}`)
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) throw new Error("body is not an object")
  return parsed
}

/** The URL a fetch was called with, whatever form it came in. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

/**
 * A fetch that answers `/apply-template` and `/tokenize` like a working server and hands every
 * `/completion` the response `completionResponse` builds.
 */
function fetchWithCompletion(completionResponse: () => Response): typeof fetch {
  return (input) => {
    const url = urlOf(input)
    if (url.endsWith("/apply-template")) {
      return Promise.resolve(Response.json({ prompt: "P" }))
    }
    if (url.endsWith("/tokenize")) {
      return Promise.resolve(Response.json({ tokens: [1] }))
    }
    return Promise.resolve(completionResponse())
  }
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
    expect(completion(server, 0).body.n_predict).toBe(10)
  })
})

describe("truncation tripwire", () => {
  test("rejects malformed non-streaming completion fields", async () => {
    const server = await start({ replies: [] })
    for (const payload of [
      { content: "x", stop_type: "eos" },
      { content: "x", stop_type: "unknown", tokens_evaluated: 1 },
    ]) {
      const client = createModelClient(config(server), {
        fetch: fetchWithCompletion(() => Response.json(payload)),
      })
      const error = await rejection(
        client.complete({
          system: "",
          messages: [userOf(1)],
          includeTokenProbabilities: true,
        })
      )
      expect(error).toMatchObject({ kind: "malformed", status: 200 })
    }
  })

  test("returns aligned token probabilities from llama-server logprob metadata", async () => {
    const server = await start({
      replies: [
        {
          deltas: ["hello"],
          probabilities: [
            { token: "hel", probability: 0.7 },
            { token: "lo", probability: 0.9 },
          ],
        },
      ],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
      includeTokenProbabilities: true,
    })
    expect(result.tokenProbabilities).toEqual([
      { bytes: [104, 101, 108], probability: 0.7 },
      { bytes: [108, 111], probability: 0.9 },
    ])
  })

  test("ignores incomplete or misaligned probability metadata", async () => {
    const server = await start({
      replies: [
        {
          deltas: ["hello"],
          probabilities: [{ token: "hell", probability: 0.7 }],
        },
      ],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
      includeTokenProbabilities: true,
    })
    expect(result).not.toHaveProperty("tokenProbabilities")
  })

  test("treats invalid UTF-8 probability metadata as unavailable", async () => {
    const server = await start({
      replies: [
        {
          deltas: ["x"],
          probabilityBytes: [{ bytes: [0xc3], probability: 0.7 }],
        },
      ],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
      includeTokenProbabilities: true,
    })
    expect(result).not.toHaveProperty("tokenProbabilities")
  })

  test("treats out-of-range byte and probability metadata as unavailable", async () => {
    const server = await start({
      replies: [
        {
          deltas: ["x"],
          probabilityBytes: [{ bytes: [256], probability: 0.7 }],
        },
        {
          deltas: ["x"],
          probabilities: [{ token: "x", probability: 1.2 }],
        },
      ],
    })
    for (let i = 0; i < 2; i += 1) {
      const result = await createModelClient(config(server)).complete({
        system: "",
        messages: [userOf(1)],
        includeTokenProbabilities: true,
      })
      expect(result).not.toHaveProperty("tokenProbabilities")
    }
  })

  test("keeps UTF-8 bytes split across probability tokens aligned", async () => {
    const server = await start({
      replies: [
        {
          deltas: ["é"],
          probabilityBytes: [
            { bytes: [0xc3], probability: 0.4 },
            { bytes: [0xa9], probability: 0.8 },
          ],
        },
      ],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
      includeTokenProbabilities: true,
    })
    expect(result.tokenProbabilities).toEqual([
      { bytes: [0xc3], probability: 0.4 },
      { bytes: [0xa9], probability: 0.8 },
    ])
  })

  test("ignores empty probability entries", async () => {
    const server = await start({
      replies: [
        { deltas: [""], probabilityBytes: [{ bytes: [], probability: 0.8 }] },
      ],
    })
    const result = await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
      includeTokenProbabilities: true,
    })
    expect(result).not.toHaveProperty("tokenProbabilities")
  })

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

  test("equal system prompt and tools give byte-identical template prefixes", async () => {
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
    expect(
      server.requests
        .filter((r) => r.path === "/apply-template")
        .map((r) => r.body.startsWith(prefix))
    ).toEqual([true, true])
  })

  test("the rendered prompt reaches /completion as token ids, BOS first, with cache_prompt", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    await createModelClient(config(server)).complete({
      system: "S",
      messages: [{ role: "user", content: "hi <|im_end|>" }],
    })
    const sent = completion(server, 0)
    expect(sent.tokens[0]).toBe(BOS_ID)
    // Owner words are trusted text: the template and the special-token parser see them as
    // written, so a control-token string in them is a control token.
    expect(stubDecode(sent.tokens.slice(1))).toBe(
      "<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nhi <|im_end|><|im_end|>\n<|im_start|>assistant\n"
    )
    expect(sent.body).toEqual({
      n_predict: 100,
      stream: true,
      cache_prompt: true,
    })
  })

  test("sends each prompt through /apply-template, /tokenize, then /completion", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
    })
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /apply-template",
      "POST /tokenize",
      "POST /completion",
    ])
  })

  test("with jsonSchema the schema is sent as json_schema", async () => {
    const server = await start({ replies: [{ deltas: ["{}"] }] })
    const schema = { type: "object", properties: { ok: { type: "boolean" } } }
    await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
      jsonSchema: schema,
    })
    expect(completion(server, 0).body.json_schema).toEqual(schema)
  })

  test("without jsonSchema there is no json_schema key", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    await createModelClient(config(server)).complete({
      system: "",
      messages: [userOf(1)],
    })
    expect(completion(server, 0).body).not.toHaveProperty("json_schema")
  })

  test("material is tokenized alone with parse_special off; trusted pieces with it on", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    await createModelClient(config(server)).complete({
      system: "S",
      messages: [
        {
          role: "user",
          content: [
            fence(
              toMaterial("body", { source: "mail", from: "a@example.invalid" })
            ),
            "Q",
          ],
        },
      ],
    })
    const tokenizeBodies = server.requests
      .filter((r) => r.path === "/tokenize")
      .map((r): unknown => JSON.parse(r.body))
    expect(tokenizeBodies).toEqual([
      expect.objectContaining({ add_special: true, parse_special: true }),
      {
        content: "a@example.invalid",
        add_special: false,
        parse_special: false,
      },
      expect.objectContaining({ add_special: false, parse_special: true }),
      { content: "body", add_special: false, parse_special: false },
      expect.objectContaining({ add_special: false, parse_special: true }),
    ])
  })

  test("material never reaches /apply-template", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    await createModelClient(config(server)).complete({
      system: "S",
      messages: [
        {
          role: "user",
          content: [fence(toMaterial("secret-body", { source: "document" }))],
        },
      ],
    })
    expect(bodyAt(server, "/apply-template")).toEqual({
      messages: [
        { role: "system", content: "S" },
        {
          role: "user",
          content: expect.not.stringContaining("secret-body") as unknown,
        },
      ],
    })
  })
})

describe("splitRendered", () => {
  test("cuts the rendered prompt at each placeholder, in order", () => {
    const rendered = `a${placeholder("n", 0)}b${placeholder("n", 1)}c`
    expect(splitRendered(rendered, "n", 2)).toEqual(["a", "b", "c"])
  })

  test("a prompt with no spans is one piece", () => {
    expect(splitRendered("abc", "n", 0)).toEqual(["abc"])
  })

  test.each([
    ["out of order", `${placeholder("n", 1)}${placeholder("n", 0)}`, 2],
    ["repeated", `${placeholder("n", 0)}${placeholder("n", 0)}`, 1],
    ["missing", `x`, 1],
  ])("a placeholder %s is refused", (_name, rendered, count) => {
    expect(() => splitRendered(rendered, "n", count)).toThrow(
      "the rendered template does not hold each material placeholder once, in order"
    )
  })

  test("a template that rewrites a placeholder sends nothing", async () => {
    const server = await start({
      replies: [{ deltas: ["ok"] }],
      renderedPrompt: (prompt) => prompt.replaceAll("eido:", "EIDO:"),
    })
    const error = await rejection(
      createModelClient(config(server)).complete({
        system: "",
        messages: [
          {
            role: "user",
            content: [fence(toMaterial("m", { source: "mail" }))],
          },
        ],
      })
    )
    expect(error).toMatchObject({ kind: "malformed" })
    expect(server.completions()).toEqual([])
  })
})

describe("server features", () => {
  test.each(["apply-template", "tokenize"] as const)(
    "a server without /%s fails with a named error and sends no prompt",
    async (feature) => {
      const server = await start({
        replies: [{ deltas: ["ok"] }],
        missing: [feature],
      })
      const error = await rejection(
        createModelClient(config(server)).complete({
          system: "",
          messages: [userOf(1)],
        })
      )
      expect(error).toBeInstanceOf(UnsupportedModelServerError)
      expect(error).toMatchObject({
        name: "UnsupportedModelServerError",
        feature,
      })
      expect(server.completions()).toEqual([])
    }
  )

  test.each(["apply-template", "tokenize"] as const)(
    "connectModelClient fails at startup without /%s and sends no prompt",
    async (feature) => {
      const server = await start({
        replies: [{ deltas: ["ok"] }],
        missing: [feature],
      })
      const error = await rejection(connectModelClient(config(server)))
      expect(error).toMatchObject({
        name: "UnsupportedModelServerError",
        feature,
      })
      expect(server.completions()).toEqual([])
    }
  )

  test("connectModelClient fails when /tokenize ignores parse_special", async () => {
    const server = await start({
      replies: [{ deltas: ["ok"] }],
      ignoreParseSpecial: true,
    })
    const error = await rejection(connectModelClient(config(server)))
    expect(error).toMatchObject({
      name: "UnsupportedModelServerError",
      feature: "parse_special",
    })
    expect(server.completions()).toEqual([])
  })

  test("sends the configured chat template kwargs with every /apply-template request", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    const kwargs = { enable_thinking: false, b: { y: 1, x: 2 } }
    const client = await connectModelClient(
      config(server, { chatTemplateKwargs: kwargs })
    )
    await client.complete({ system: "", messages: [userOf(1)] })
    const probe = bodyAt(server, "/apply-template", 0)
    const request = bodyAt(server, "/apply-template", 1)
    expect(probe.chat_template_kwargs).toEqual(kwargs)
    expect(request.chat_template_kwargs).toEqual(kwargs)
    expect(
      server.requests.filter((r) => r.path === "/apply-template")[1]?.body
    ).toContain(
      '"chat_template_kwargs":{"b":{"x":2,"y":1},"enable_thinking":false}'
    )
  })

  test("sends no chat template kwargs when none are configured", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    const client = await connectModelClient(config(server))
    await client.complete({ system: "", messages: [userOf(1)] })
    expect(bodyAt(server, "/apply-template", 0)).not.toHaveProperty(
      "chat_template_kwargs"
    )
    expect(bodyAt(server, "/apply-template", 1)).not.toHaveProperty(
      "chat_template_kwargs"
    )
  })

  test("connectModelClient returns a working client for a capable server", async () => {
    const server = await start({ replies: [{ deltas: ["ok"] }] })
    const client = await connectModelClient(config(server))
    expect(server.completions()).toEqual([])
    const result = await client.complete({ system: "", messages: [userOf(1)] })
    expect(result.text).toBe("ok")
  })

  test.each([
    [
      "an /apply-template answer with no prompt",
      { "/apply-template": Response.json({}) },
      "/apply-template answer has no prompt",
    ],
    [
      "an /apply-template answer that is not JSON",
      { "/apply-template": new Response("nope") },
      "/apply-template answer is not JSON",
    ],
    [
      "an /apply-template answer that is not an object",
      { "/apply-template": Response.json([1]) },
      "/apply-template answer is not an object",
    ],
    [
      "a /tokenize answer with ids that are not integers",
      { "/tokenize": Response.json({ tokens: [1.5] }) },
      "/tokenize answer has no list of token ids",
    ],
    [
      "a /tokenize answer with no tokens",
      { "/tokenize": Response.json({}) },
      "/tokenize answer has no list of token ids",
    ],
  ])("%s rejects as malformed", async (_name, answers, message) => {
    const routes: Record<string, Response> = {
      "/apply-template": Response.json({ prompt: "P" }),
      "/tokenize": Response.json({ tokens: [1] }),
      ...answers,
    }
    const calls: string[] = []
    const doFetch: typeof fetch = (input) => {
      const path = new URL(urlOf(input)).pathname
      calls.push(path)
      const answer = routes[path]
      return Promise.resolve(answer ?? new Response(null, { status: 500 }))
    }
    const client = createModelClient(
      {
        baseUrl: "http://127.0.0.1:1",
        contextTokens: 4096,
        maxReplyTokens: 100,
      },
      { fetch: doFetch }
    )
    const error = await rejection(
      client.complete({ system: "", messages: [userOf(1)] })
    )
    expect(error).toMatchObject({ kind: "malformed", message })
    expect(calls).not.toContain("/completion")
  })

  test("another error status on /tokenize rejects as http, not unsupported", async () => {
    const client = createModelClient(
      {
        baseUrl: "http://127.0.0.1:1",
        contextTokens: 4096,
        maxReplyTokens: 100,
      },
      {
        fetch: (input) =>
          Promise.resolve(
            urlOf(input).endsWith("/tokenize")
              ? new Response("{}", { status: 503 })
              : Response.json({ prompt: "P" })
          ),
      }
    )
    const error = await rejection(
      client.complete({ system: "", messages: [userOf(1)] })
    )
    expect(error).toBeInstanceOf(InferenceError)
    expect(error).toMatchObject({
      kind: "http",
      status: 503,
      message: "model server answered 503 on /tokenize",
    })
  })

  test("an abort while reading a JSON answer rejects as aborted", async () => {
    const controller = new AbortController()
    const client = createModelClient(
      {
        baseUrl: "http://127.0.0.1:1",
        contextTokens: 4096,
        maxReplyTokens: 100,
      },
      {
        fetch: () => {
          controller.abort()
          return Promise.resolve(new Response("not json"))
        },
      }
    )
    const error = await rejection(
      client.complete(
        { system: "", messages: [userOf(1)] },
        { signal: controller.signal }
      )
    )
    expect(error).toMatchObject({ kind: "aborted" })
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
    expect(server.completions()).toHaveLength(1)
  })

  test("aborting mid-stream rejects as aborted and is not retried", async () => {
    let streamStarted: (() => void) | undefined
    const streaming = new Promise<void>((resolve) => {
      streamStarted = resolve
    })
    const server = await start({
      replies: [
        {
          deltas: ["partial"],
          hang: true,
          onFirstChunk: () => streamStarted?.(),
        },
      ],
    })
    const controller = new AbortController()
    const pending = createModelClient(config(server)).complete(
      { system: "", messages: [userOf(1)] },
      { signal: controller.signal }
    )
    await streaming
    controller.abort()
    const error = await rejection(pending)
    expect(error).toBeInstanceOf(InferenceError)
    expect(error).toMatchObject({ kind: "aborted", status: null })
    expect(server.completions()).toHaveLength(1)
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
            'data: {"content":"hi","stop":false}\n\n' +
            'data: {"content":"","stop":true,"stop_type":"eos","tokens_evaluated":3}',
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
    const fetchBadBytes = fetchWithCompletion(
      () =>
        new Response(
          new Uint8Array([
            0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a,
          ]),
          { status: 200 }
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
      { fetch: fetchWithCompletion(() => new Response(null, { status: 200 })) }
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

describe("readModelId", () => {
  test("reads the active id from the local model server", async () => {
    const server = await start({ replies: [] })
    expect(await readModelId(server.url)).toBe("local")
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/models",
    })
  })

  test("refuses a server response without a model id", async () => {
    await expect(
      readModelId("http://127.0.0.1:8080", {
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ data: [{ id: " " }] }))
          ),
      })
    ).rejects.toThrow("local model server /v1/models has no model id")
  })
})
