import { describe, expect, test } from "vitest"
import {
  DEFAULT_SEED,
  defaultCandidate,
  parseCandidates,
  parseCliOptions,
} from "./config"

describe("eval runner options", () => {
  test("defaults to eval-local/, its verdicts.json, .eval-results/ and the default seed", () => {
    expect(parseCliOptions([], {})).toEqual({
      cases: "eval-local",
      verdicts: "eval-local/verdicts.json",
      out: ".eval-results",
      seed: DEFAULT_SEED,
      enforce: false,
    })
  })

  test("reads EIDO_EVAL_* variables, and flags win over them", () => {
    const env = {
      EIDO_EVAL_CASES: "/owner/cases",
      EIDO_EVAL_OUT: "/owner/out",
      EIDO_EVAL_SEED: "7",
      EIDO_EVAL_CANDIDATES: "/owner/candidates.json",
    }
    expect(parseCliOptions([], env)).toEqual({
      cases: "/owner/cases",
      verdicts: "/owner/cases/verdicts.json",
      out: "/owner/out",
      seed: 7,
      enforce: false,
      candidates: "/owner/candidates.json",
    })
    expect(
      parseCliOptions(
        [
          "--",
          "--cases",
          "c",
          "--verdicts",
          "v.json",
          "--seed",
          "11",
          "--candidates",
          "k.json",
          "--enforce",
        ],
        { ...env, EIDO_EVAL_VERDICTS: "/owner/verdicts.json" }
      )
    ).toEqual({
      cases: "c",
      verdicts: "v.json",
      out: "/owner/out",
      seed: 11,
      enforce: true,
      candidates: "k.json",
    })
  })

  test("refuses unknown flags, missing values and bad seeds", () => {
    expect(() => parseCliOptions(["--model", "x"], {})).toThrow(
      "unknown eval argument --model"
    )
    expect(() => parseCliOptions(["--cases"], {})).toThrow(
      "--cases requires a value"
    )
    expect(() => parseCliOptions(["--out", "--enforce"], {})).toThrow(
      "--out requires a value"
    )
    expect(() => parseCliOptions(["--seed", "-1"], {})).toThrow(
      "--seed must be a non-negative integer"
    )
    expect(() => parseCliOptions([], { EIDO_EVAL_SEED: "1.5" })).toThrow(
      "EIDO_EVAL_SEED must be a non-negative integer"
    )
  })

  test("the default candidate is the data plane's llama-server address", () => {
    expect(defaultCandidate({ EIDO_LLAMA_PORT: "8080" })).toEqual({
      name: "default",
      baseUrl: "http://127.0.0.1:8080",
    })
    expect(
      defaultCandidate({ EIDO_LLAMA_HOST: "::1", EIDO_LLAMA_PORT: "8081" })
    ).toEqual({ name: "default", baseUrl: "http://[::1]:8081" })
    expect(() => defaultCandidate({ EIDO_LLAMA_PORT: "" })).toThrow(
      "set EIDO_LLAMA_PORT"
    )
  })
})

describe("candidates file", () => {
  test("parses candidates with quantization, template kwargs and a server command", () => {
    expect(
      parseCandidates(
        {
          candidates: [
            { name: "a", baseUrl: "http://127.0.0.1:8081" },
            {
              name: "qwen-q4_k_m",
              baseUrl: "http://localhost:8082",
              quantization: "Q4_K_M",
              chatTemplateKwargs: { enable_thinking: false },
              server: {
                command: ["llama-server", "-m", "model.gguf", "--port", "8082"],
                readyTimeoutSeconds: 900,
              },
            },
            {
              name: "b",
              baseUrl: "http://127.0.0.1:8083",
              server: { command: ["llama-server"] },
            },
          ],
        },
        "candidates.json"
      )
    ).toEqual([
      { name: "a", baseUrl: "http://127.0.0.1:8081" },
      {
        name: "qwen-q4_k_m",
        baseUrl: "http://localhost:8082",
        quantization: "Q4_K_M",
        chatTemplateKwargs: { enable_thinking: false },
        server: {
          command: ["llama-server", "-m", "model.gguf", "--port", "8082"],
          readyTimeoutSeconds: 900,
        },
      },
      {
        name: "b",
        baseUrl: "http://127.0.0.1:8083",
        server: { command: ["llama-server"] },
      },
    ])
  })

  const ok = { name: "a", baseUrl: "http://127.0.0.1:8081" }
  test.each([
    [[], "f: expected an object"],
    [{ candidates: [] }, "f.candidates: expected a non-empty array"],
    [{ candidates: [ok], extra: 1 }, "f.extra: is not a supported field"],
    [{ candidates: [1] }, "f.candidates[0]: expected an object"],
    [
      { candidates: [{ ...ok, model: "x" }] },
      "f.candidates[0].model: is not a supported field",
    ],
    [
      { candidates: [{ ...ok, name: "Has Space" }] },
      "f.candidates[0].name: use lowercase",
    ],
    [{ candidates: [{ ...ok, name: "" }] }, "f.candidates[0].name: expected"],
    [
      { candidates: [{ ...ok, baseUrl: "http://192.0.2.1:8080" }] },
      "f.candidates[0].baseUrl: inference is local",
    ],
    [
      { candidates: [{ ...ok, quantization: 4 }] },
      "f.candidates[0].quantization: expected a non-empty string",
    ],
    [
      { candidates: [{ ...ok, chatTemplateKwargs: [] }] },
      "f.candidates[0].chatTemplateKwargs: expected an object",
    ],
    [
      { candidates: [{ ...ok, server: "llama-server" }] },
      "f.candidates[0].server: expected an object",
    ],
    [
      { candidates: [{ ...ok, server: { command: [] } }] },
      "f.candidates[0].server.command: expected a non-empty array",
    ],
    [
      { candidates: [{ ...ok, server: { command: ["x", ""] } }] },
      "f.candidates[0].server.command[1]: expected a non-empty string",
    ],
    [
      { candidates: [{ ...ok, server: { command: ["x"], shell: true } }] },
      "f.candidates[0].server.shell: is not a supported field",
    ],
    [
      {
        candidates: [
          { ...ok, server: { command: ["x"], readyTimeoutSeconds: 0 } },
        ],
      },
      "f.candidates[0].server.readyTimeoutSeconds: expected a positive number",
    ],
    [{ candidates: [ok, ok] }, "f.candidates[1].name: duplicate name a"],
  ])("refuses %j", (value, message) => {
    expect(() => parseCandidates(value, "f")).toThrow(message)
  })
})
