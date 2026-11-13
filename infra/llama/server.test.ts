import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import {
  checkHiddenTokens,
  checkJsonSchema,
  DEFAULT_HIDDEN_TOKENS,
  findHiddenToken,
  openReasoningBlock,
  checkProps,
  checkRenderedPrompt,
  firstDifference,
  matchesSchema,
  serverArgs,
  waitHealthy,
  type Fetch,
  type HttpResponse,
} from "./server.ts"

const reply = (status: number, body: unknown): HttpResponse => ({
  status,
  json: () => Promise.resolve(body),
})

describe("serverArgs", () => {
  const args = serverArgs("/m/model.gguf", 18080, {
    chatTemplateKwargs: undefined,
    flags: ["--reasoning", "off"],
  })

  it("binds loopback only, with the model's own template", () => {
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1")
    expect(args).toContain("--jinja")
    expect(args).not.toContain("0.0.0.0")
  })

  it("passes the model and port, the flags measured in #69, then the profile's flags", () => {
    expect(args).toEqual([
      "-m",
      "/m/model.gguf",
      "--jinja",
      "--host",
      "127.0.0.1",
      "--port",
      "18080",
      "-c",
      "8192",
      "-fa",
      "on",
      "--cache-type-k",
      "q8_0",
      "--cache-type-v",
      "q8_0",
      "-ngl",
      "99",
      "-b",
      "2048",
      "-ub",
      "2048",
      "-t",
      "8",
      "--reasoning",
      "off",
    ])
  })
})

describe("serverArgs with chat template kwargs", () => {
  it("passes them to llama-server as compact JSON before the profile's flags", () => {
    const args = serverArgs("/m/q.gguf", 8080, {
      chatTemplateKwargs: { enable_thinking: false },
      flags: ["-c", "16384"],
    })
    expect(args.slice(-4)).toEqual([
      "--chat-template-kwargs",
      '{"enable_thinking":false}',
      "-c",
      "16384",
    ])
  })

  it("adds nothing for a profile without kwargs or flags", () => {
    expect(
      serverArgs("/m/q.gguf", 8080, {
        chatTemplateKwargs: undefined,
        flags: [],
      }).at(-1)
    ).toBe("8")
  })
})

describe("waitHealthy", () => {
  function clock() {
    let t = 0
    return {
      now: () => t,
      sleep: (ms: number) => ((t += ms), Promise.resolve()),
    }
  }

  it("returns once /health answers 200, after polling through refusals and 503s", async () => {
    const c = clock()
    const urls: string[] = []
    const answers = [new Error("ECONNREFUSED"), 503, 200]
    const fetch: Fetch = (url) => {
      urls.push(url)
      const next = answers.shift()
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(reply(next ?? 500, {}))
    }
    const result = await waitHealthy(8080, 10_000, {
      fetch,
      ...c,
      exited: new Promise(() => {}),
    })
    expect(result).toEqual({ ok: true, ms: 500 })
    expect(urls).toEqual(Array(3).fill("http://127.0.0.1:8080/health"))
  })

  it("gives up after the timeout", async () => {
    const c = clock()
    const fetch: Fetch = () => Promise.resolve(reply(503, {}))
    expect(
      await waitHealthy(8080, 1000, {
        fetch,
        ...c,
        exited: new Promise(() => {}),
      })
    ).toEqual({
      ok: false,
      message: "/health did not answer 200 within 1 s",
    })
  })

  it("stops waiting when the server exits", async () => {
    const c = clock()
    const fetch: Fetch = () => Promise.reject(new Error("ECONNREFUSED"))
    expect(
      await waitHealthy(8080, 60_000, {
        fetch,
        ...c,
        exited: Promise.resolve(3),
      })
    ).toEqual({
      ok: false,
      message: "llama-server exited with code 3 before /health answered",
    })
  })
})

describe("checkProps", () => {
  const marker = "<|start_header_id|>"
  const props =
    (body: unknown): Fetch =>
    (url) => {
      expect(url).toBe("http://127.0.0.1:8080/props")
      return Promise.resolve(reply(200, body))
    }

  it("passes when the template has the marker", async () => {
    expect(
      await checkProps(
        8080,
        marker,
        props({ chat_template: "{{ '<|start_header_id|>' + role }}" })
      )
    ).toEqual({ ok: true })
  })

  it("fails for another model's template", async () => {
    expect(
      await checkProps(
        8080,
        marker,
        props({ chat_template: "<start_of_turn>user" })
      )
    ).toEqual({
      ok: false,
      message: '/props chat_template does not contain "<|start_header_id|>"',
    })
  })

  it("fails without a template", async () => {
    expect(await checkProps(8080, marker, props({}))).toEqual({
      ok: false,
      message: "/props has no chat_template",
    })
  })

  it("without a marker, passes any loaded template but not an empty one", async () => {
    expect(
      await checkProps(8080, undefined, props({ chat_template: "{{ x }}" }))
    ).toEqual({ ok: true })
    expect(
      await checkProps(8080, undefined, props({ chat_template: "" }))
    ).toEqual({ ok: false, message: "/props has no chat_template" })
  })

  it("fails when the request fails", async () => {
    expect(
      await checkProps(8080, marker, () =>
        Promise.reject(new Error("ECONNREFUSED"))
      )
    ).toEqual({ ok: false, message: "/props failed: ECONNREFUSED" })
  })
})

describe("firstDifference", () => {
  it("finds the first differing index, including a length difference", () => {
    expect(firstDifference("abc", "abc")).toBe(-1)
    expect(firstDifference("abXd", "abcd")).toBe(2)
    expect(firstDifference("ab", "abc")).toBe(2)
  })
})

const reference = readFileSync(
  new URL(
    "./fixtures/meta-llama-3.1-8b-instruct-q4_0.gguf.prompt.txt",
    import.meta.url
  ),
  "utf8"
).replace(/\r\n/g, "\n")

describe("checkRenderedPrompt", () => {
  it("sends the fixed conversation and passes on an exact match", async () => {
    let sent: unknown
    const fetch: Fetch = (url, init) => {
      expect(url).toBe("http://127.0.0.1:8080/apply-template")
      sent = JSON.parse(init?.body ?? "null")
      return Promise.resolve(reply(200, { prompt: reference }))
    }
    expect(await checkRenderedPrompt(8080, reference, fetch)).toEqual({
      ok: true,
    })
    expect(sent).toMatchObject({
      messages: [
        { role: "system" },
        { role: "user", content: "What is the weather in Testville?" },
        {
          role: "assistant",
          tool_calls: [{ function: { name: "get_weather" } }],
        },
        { role: "tool", tool_call_id: "call_1" },
        { role: "assistant" },
        { role: "user", content: "Thanks." },
      ],
    })
  })

  it("names where a drifted template differs", async () => {
    const drifted = reference.replace("Thanks.", "Thanks!")
    const result = await checkRenderedPrompt(8080, reference, () =>
      Promise.resolve(reply(200, { prompt: drifted }))
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(
      new RegExp(
        `^rendered prompt differs from the reference at character ${reference.indexOf("Thanks.") + 6}: `
      )
    )
  })

  it("fails without a prompt or on a failed request", async () => {
    expect(
      await checkRenderedPrompt(8080, reference, () =>
        Promise.resolve(reply(500, {}))
      )
    ).toEqual({ ok: false, message: "/apply-template returned no prompt" })
    expect(
      await checkRenderedPrompt(8080, reference, () =>
        Promise.reject(new Error("timeout"))
      )
    ).toEqual({ ok: false, message: "/apply-template failed: timeout" })
  })
})

describe("the reference prompt fixture", () => {
  it("keeps the turns in order and renders the tool-call turn empty, as the GGUF template does", () => {
    expect(reference).toContain(
      '<|start_header_id|>user<|end_header_id|>\n\nWhat is the weather in Testville?<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n<|eot_id|><|start_header_id|>tool<|end_header_id|>\n\n{"forecast":"sunny"}<|eot_id|>'
    )
    expect(
      reference.endsWith("<|start_header_id|>assistant<|end_header_id|>\n\n")
    ).toBe(true)
    expect(reference).not.toContain("get_weather")
  })
})

describe("matchesSchema", () => {
  it.each([
    ['{"city":"a","country":"b","summary":"c","unit":"d"}', true],
    ['{"city":"a","country":"b","summary":"c"}', false],
    ['{"city":"a","country":"b","summary":"c","unit":"d","extra":"e"}', false],
    ['{"city":1,"country":"b","summary":"c","unit":"d"}', false],
    ['["city"]', false],
    ["not json", false],
  ])("%s → %s", (text, expected) => {
    expect(matchesSchema(text)).toBe(expected)
  })
})

describe("checkJsonSchema", () => {
  const completion =
    (content: unknown): Fetch =>
    (url, init) => {
      expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions")
      expect(JSON.parse(init?.body ?? "null")).toMatchObject({
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { strict: true } },
      })
      return Promise.resolve(
        reply(200, { choices: [{ message: { content } }] })
      )
    }

  it("passes when the completion matches the schema", async () => {
    expect(
      await checkJsonSchema(
        8080,
        completion(
          '{"city":"Testville","country":"Exampleland","summary":"Sunny","unit":"celsius"}'
        )
      )
    ).toEqual({ ok: true })
  })

  it("fails on JSON that breaks the schema, quoting it", async () => {
    expect(
      await checkJsonSchema(8080, completion('{"city":"Testville"}'))
    ).toEqual({
      ok: false,
      message:
        'the completion does not match the schema: "{\\"city\\":\\"Testville\\"}"',
    })
  })

  it("fails without content or on a failed request", async () => {
    expect(await checkJsonSchema(8080, completion(null))).toEqual({
      ok: false,
      message: "the completion has no message content",
    })
    expect(
      await checkJsonSchema(8080, () => Promise.reject(new Error("reset")))
    ).toEqual({
      ok: false,
      message: "/v1/chat/completions failed: reset",
    })
  })
})

describe("findHiddenToken", () => {
  it("reports the earliest listed token and where it starts", () => {
    expect(
      findHiddenToken("ok <|im_end|> then <think>", DEFAULT_HIDDEN_TOKENS)
    ).toEqual({
      token: "<|im_end|>",
      at: 3,
    })
  })

  it("finds nothing in clean text, or for a token the list does not name", () => {
    expect(
      findHiddenToken("Hello, world.", DEFAULT_HIDDEN_TOKENS)
    ).toBeUndefined()
    expect(findHiddenToken("a <think> b", ["<|channel|>"])).toBeUndefined()
  })
})

describe("openReasoningBlock", () => {
  it("flags a generation prompt that opens a reasoning block", () => {
    expect(openReasoningBlock("<|im_start|>assistant\n<think>\n")).toBe(
      "<think>"
    )
  })

  it("accepts a block the template closed, and a prompt with none", () => {
    expect(
      openReasoningBlock("<|im_start|>assistant\n<think>\n\n</think>\n\n")
    ).toBeUndefined()
    expect(openReasoningBlock("<|turn>model\n")).toBeUndefined()
  })
})

describe("checkHiddenTokens", () => {
  const completion = (content: unknown) => ({
    choices: [{ message: { content } }],
  })
  const server =
    (prompt: string, content: unknown): Fetch =>
    (url) =>
      Promise.resolve(
        reply(
          200,
          url.endsWith("/apply-template") ? { prompt } : completion(content)
        )
      )

  it("passes a clean reply, sending one plain request with no schema", async () => {
    let sent: unknown
    const fetch: Fetch = (url, init) => {
      if (url.endsWith("/v1/chat/completions"))
        sent = JSON.parse(init?.body ?? "null")
      return server("<|turn>model\n", "Hello there.")(url, init)
    }
    expect(await checkHiddenTokens(8080, DEFAULT_HIDDEN_TOKENS, fetch)).toEqual(
      {
        ok: true,
      }
    )
    expect(sent).not.toHaveProperty("response_format")
  })

  it("fails a reply that leaks <think>, naming the token and where", async () => {
    const result = await checkHiddenTokens(
      8080,
      DEFAULT_HIDDEN_TOKENS,
      server("<|turn>model\n", "Hi <think>plan</think>")
    )
    expect(result).toEqual({
      ok: false,
      message:
        'the reply contains <think> at character 3: "Hi <think>plan</think>"',
    })
  })

  it("fails a reply that leaks <|channel|>analysis", async () => {
    const result = await checkHiddenTokens(
      8080,
      DEFAULT_HIDDEN_TOKENS,
      server("<|turn>model\n", "<|channel|>analysis<|message|>thinking")
    )
    expect(result.ok === false && result.message).toMatch(
      /^the reply contains <\|channel\|> at character 0: /
    )
  })

  it("uses the tokens the profile names instead of the defaults", async () => {
    const leaky = server("<|turn>model\n", "Hi <think>x")
    expect(await checkHiddenTokens(8080, ["<|custom|>"], leaky)).toEqual({
      ok: true,
    })
    expect(
      (
        await checkHiddenTokens(
          8080,
          ["<|custom|>"],
          server("p", "a <|custom|>")
        )
      ).ok
    ).toBe(false)
  })

  it("fails when the generation prompt opens a reasoning block", async () => {
    const result = await checkHiddenTokens(
      8080,
      DEFAULT_HIDDEN_TOKENS,
      server("<|im_start|>assistant\n<think>\n", "Hello.")
    )
    expect(result).toEqual({
      ok: false,
      message:
        "the generation prompt opens <think> and never closes it; set the profile's chat_template_kwargs or flags to turn thinking off",
    })
  })

  it("fails without message content, without a prompt, or on a failed request", async () => {
    expect(
      await checkHiddenTokens(8080, DEFAULT_HIDDEN_TOKENS, server("p", null))
    ).toEqual({ ok: false, message: "the completion has no message content" })
    expect(
      await checkHiddenTokens(8080, DEFAULT_HIDDEN_TOKENS, () =>
        Promise.resolve(reply(200, {}))
      )
    ).toEqual({ ok: false, message: "/apply-template returned no prompt" })
    expect(
      await checkHiddenTokens(8080, DEFAULT_HIDDEN_TOKENS, () =>
        Promise.reject(new Error("ECONNREFUSED"))
      )
    ).toEqual({ ok: false, message: "/apply-template failed: ECONNREFUSED" })
  })

  it("reports a failed completion request", async () => {
    const fetch: Fetch = (url) =>
      url.endsWith("/apply-template")
        ? Promise.resolve(reply(200, { prompt: "p" }))
        : Promise.reject(new Error("reset"))
    expect(await checkHiddenTokens(8080, DEFAULT_HIDDEN_TOKENS, fetch)).toEqual(
      {
        ok: false,
        message: "/v1/chat/completions failed: reset",
      }
    )
  })
})
