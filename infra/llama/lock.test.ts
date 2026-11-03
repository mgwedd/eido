import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { parseLock } from "./lock.ts"

const committed = readFileSync(
  new URL("../model.lock", import.meta.url),
  "utf8"
)

const valid = `# comment
model: Example-Model
quantization: Q4_0
file: example.gguf
source: https://example.invalid/rev/abc/example.gguf
size: 1234
sha256: ${"a".repeat(64)}
llama_cpp_build: b100
llama_cpp_commit: abcdef1
llama_cpp_asset: llama-b100-bin-macos-arm64.tar.gz
llama_cpp_sha256: ${"b".repeat(64)}
chat_template_marker: <|start_header_id|>
`

const replace = (key: string, line: string) =>
  valid.replace(new RegExp(`^${key}: .*$`, "m"), line)

describe("the committed infra/model.lock", () => {
  it("pins the model and build measured in #69", () => {
    expect(parseLock(committed)).toEqual({
      model: "Meta-Llama-3.1-8B-Instruct",
      quantization: "Q4_0",
      file: "meta-llama-3.1-8b-instruct-q4_0.gguf",
      source:
        "https://huggingface.co/ggml-org/Meta-Llama-3.1-8B-Instruct-Q4_0-GGUF/resolve/0aba27dd2f1c7f4941a94a5c59d80e0a256f9ff8/meta-llama-3.1-8b-instruct-q4_0.gguf",
      size: 6036116480,
      sha256:
        "b4778681efbd6898fe1965e74f810b3b7dfdf6afab01df9c88c1b0e6e9ca122d",
      llamaCppBuild: "b11149",
      llamaCppCommit: "d2e54583c",
      llamaCppAsset: "llama-b11149-bin-macos-arm64.tar.gz",
      llamaCppSha256:
        "791eb0200a7c846ca925b6274fc21f0f21f537fda2924cc5a47402655816f56e",
      chatTemplateMarker: "<|start_header_id|>",
    })
  })
})

describe("parseLock", () => {
  it("keeps a value that itself contains a colon", () => {
    expect(parseLock(valid).source).toBe(
      "https://example.invalid/rev/abc/example.gguf"
    )
  })

  it.each([
    [
      "a missing key",
      valid.replace(/^size: .*\n/m, ""),
      "model.lock is missing size",
    ],
    ["an unknown key", `${valid}revision: x\n`, 'unknown key "revision"'],
    ["a repeated key", `${valid}size: 5\n`, "size appears twice"],
    ["an empty value", replace("model", "model:"), "model is empty"],
    ["a line without a key", `${valid}just text\n`, 'expected "key: value"'],
    [
      "a short sha256",
      replace("sha256", "sha256: abc"),
      "sha256 must be 64 lowercase hex",
    ],
    [
      "an uppercase sha256",
      replace("sha256", `sha256: ${"A".repeat(64)}`),
      "sha256 must be 64 lowercase hex",
    ],
    [
      "a path as file",
      replace("file", "file: ../x.gguf"),
      "file must be a bare file name",
    ],
    [
      "a dot-dot file",
      replace("file", "file: .."),
      "file must be a bare file name",
    ],
    [
      "an http source",
      replace("source", "source: http://example.invalid/example.gguf"),
      "source must be an https URL ending in /example.gguf",
    ],
    [
      "a source for another file",
      replace("source", "source: https://example.invalid/other.gguf"),
      "ending in /example.gguf",
    ],
    [
      "a fractional size",
      replace("size", "size: 12.5"),
      "size must be a whole number",
    ],
    ["a zero size", replace("size", "size: 0"), "size must be a whole number"],
    [
      "an unsafe size",
      replace("size", "size: 99999999999999999999"),
      "size must be a whole number",
    ],
    [
      "a build without b",
      replace("llama_cpp_build", "llama_cpp_build: 100"),
      "llama_cpp_build must look like b1234",
    ],
    [
      "a short commit",
      replace("llama_cpp_commit", "llama_cpp_commit: abc"),
      "llama_cpp_commit must be 7 to 40",
    ],
    [
      "a bad asset sha",
      replace("llama_cpp_sha256", "llama_cpp_sha256: nope"),
      "llama_cpp_sha256 must be 64",
    ],
  ])("rejects %s", (_name, text, message) => {
    expect(() => parseLock(text)).toThrow(message)
  })
})
