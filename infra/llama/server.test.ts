import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import {
  checkJsonSchema,
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
  const args = serverArgs("/m/model.gguf", 18080)

  it("binds loopback only, with the model's own template", () => {
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1")
    expect(args).toContain("--jinja")
    expect(args).not.toContain("0.0.0.0")
  })

  it("passes the model and port, and the flags measured in #69, with thinking off", () => {
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
)

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
