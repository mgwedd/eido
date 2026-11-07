import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import {
  modelPathOf,
  parseLock,
  parseUserProfiles,
  selectBuild,
  selectProfile,
  withUserProfiles,
} from "./lock.ts"

const committed = readFileSync(
  new URL("../model.lock", import.meta.url),
  "utf8"
)

const A = "a".repeat(64)
const B = "b".repeat(64)
const C = "c".repeat(64)

const valid = `# comment
llama_cpp_build: b100
llama_cpp_commit: abcdef1
default_profile: second

[build darwin-arm64]
asset: llama-b100-bin-macos-arm64.tar.gz
source: https://example.invalid/b100/llama-b100-bin-macos-arm64.tar.gz
sha256: ${B}

[build win32-x64]
asset: llama-b100-bin-win-vulkan-x64.zip
source: https://example.invalid/b100/llama-b100-bin-win-vulkan-x64.zip
sha256: ${C}

[profile first]
model: Example-Model
quantization: Q4_0
file: example.gguf
source: https://example.invalid/rev/abc/example.gguf
size: 1234
sha256: ${A}
chat_template_marker: <|start_header_id|>

[profile second]
model: Other-Model
quantization: Q8_0
path: /Users/u/.ollama/models/blobs/sha256-${A}
size: 99
sha256: ${A}
chat_template_marker: <|im_start|>assistant
chat_template_kwargs: {"enable_thinking": false}
flags: -c 16384 --reasoning off
`

/** Replaces the first line starting with `key: ` (in file order). */
const replace = (key: string, line: string) =>
  valid.replace(new RegExp(`^${key}: .*$`, "m"), line)

describe("the committed infra/model.lock", () => {
  const lock = parseLock(committed)

  it("pins build b11149 for macOS arm64, Windows x64 and arm64, and Linux x64 and arm64, with the release digests", () => {
    expect(lock.llamaCppBuild).toBe("b11149")
    expect(lock.llamaCppCommit).toBe("d2e54583c")
    expect(lock.builds).toEqual([
      {
        platform: "darwin-arm64",
        asset: "llama-b11149-bin-macos-arm64.tar.gz",
        source:
          "https://github.com/ggml-org/llama.cpp/releases/download/b11149/llama-b11149-bin-macos-arm64.tar.gz",
        sha256:
          "791eb0200a7c846ca925b6274fc21f0f21f537fda2924cc5a47402655816f56e",
      },
      {
        platform: "win32-x64",
        asset: "llama-b11149-bin-win-vulkan-x64.zip",
        source:
          "https://github.com/ggml-org/llama.cpp/releases/download/b11149/llama-b11149-bin-win-vulkan-x64.zip",
        sha256:
          "ca432b775c5dcb5af85bbdcf22b06b6e2dca792f30334b19ef4a45ee4a512446",
      },
      {
        platform: "win32-arm64",
        asset: "llama-b11149-bin-win-cpu-arm64.zip",
        source:
          "https://github.com/ggml-org/llama.cpp/releases/download/b11149/llama-b11149-bin-win-cpu-arm64.zip",
        sha256:
          "95b1f114b601498b546343b97ca381a41ffb16d88dfde19433fb95123f4ef7ca",
      },
      {
        platform: "linux-x64",
        asset: "llama-b11149-bin-ubuntu-vulkan-x64.tar.gz",
        source:
          "https://github.com/ggml-org/llama.cpp/releases/download/b11149/llama-b11149-bin-ubuntu-vulkan-x64.tar.gz",
        sha256:
          "d93606c124863e26750f0fa02daba8ae73aa39395507534fcbb57f5e7bbe7b55",
      },
      {
        platform: "linux-arm64",
        asset: "llama-b11149-bin-ubuntu-arm64.tar.gz",
        source:
          "https://github.com/ggml-org/llama.cpp/releases/download/b11149/llama-b11149-bin-ubuntu-arm64.tar.gz",
        sha256:
          "7a4ca8a91014a399dacb987efbd408621634e9079974f5a4fec80152d65b5e5b",
      },
    ])
  })

  it("keeps Gemma 4 26B-A4B QAT Q4_0 as the verified default, with thinking off", () => {
    expect(lock.defaultProfile).toBe("gemma-4-26b-a4b")
    expect(selectProfile(lock, "gemma-4-26b-a4b")).toEqual({
      id: "gemma-4-26b-a4b",
      model: "gemma-4-26B-A4B-it",
      quantization: "Q4_0 (QAT)",
      location: {
        kind: "download",
        file: "gemma-4-26B_q4_0-it.gguf",
        source:
          "https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf/resolve/d1c082be9cf3c8a514acf63b8761f4b41935842e/gemma-4-26B_q4_0-it.gguf",
      },
      size: 14439363584,
      sha256:
        "3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d",
      chatTemplateMarker: "<|turn>model",
      chatTemplateKwargs: undefined,
      flags: ["--reasoning", "off"],
      verified: true,
      origin: "lock",
    })
  })

  it("curates Qwen3.6 35B-A3B with thinking off and gpt-oss 20B at low effort, both unverified", () => {
    expect(lock.profiles.map((p) => p.id)).toEqual([
      "gemma-4-26b-a4b",
      "qwen3.6-35b-a3b",
      "gpt-oss-20b",
    ])
    expect(selectProfile(lock, "qwen3.6-35b-a3b")).toEqual({
      id: "qwen3.6-35b-a3b",
      model: "Qwen3.6-35B-A3B",
      quantization: "UD-Q4_K_M",
      location: {
        kind: "download",
        file: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
        source:
          "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/a483e9e6cbd595906af30beda3187c2663a1118c/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
      },
      size: 22134528992,
      sha256:
        "ac0e2c1189e055faa36eff361580e79c5bd6f8e76bffb4ce547f167d53e31a61",
      chatTemplateMarker: "messages[1].role == 'developer'",
      chatTemplateKwargs: { enable_thinking: false },
      flags: [],
      verified: false,
      origin: "lock",
    })
    expect(selectProfile(lock, "gpt-oss-20b")).toEqual({
      id: "gpt-oss-20b",
      model: "gpt-oss-20b",
      quantization: "MXFP4",
      location: {
        kind: "download",
        file: "gpt-oss-20b-MXFP4.gguf",
        source:
          "https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/resolve/15dcfc7e7c608c6161507211ed43c5b590801b4b/gpt-oss-20b-MXFP4.gguf",
      },
      size: 12109566624,
      sha256:
        "27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901",
      chatTemplateMarker: "<|channel|>final",
      chatTemplateKwargs: { reasoning_effort: "low" },
      flags: [],
      verified: false,
      origin: "lock",
    })
  })
})

describe("parseLock with several profiles", () => {
  const lock = parseLock(valid)

  it("reads each profile, the default and a local path with kwargs and flags", () => {
    expect(lock.defaultProfile).toBe("second")
    expect(lock.profiles.map((p) => p.id)).toEqual(["first", "second"])
    expect(selectProfile(lock, "second")).toEqual({
      id: "second",
      model: "Other-Model",
      quantization: "Q8_0",
      location: {
        kind: "local",
        path: `/Users/u/.ollama/models/blobs/sha256-${A}`,
      },
      size: 99,
      sha256: A,
      chatTemplateMarker: "<|im_start|>assistant",
      chatTemplateKwargs: { enable_thinking: false },
      flags: ["-c", "16384", "--reasoning", "off"],
      verified: false,
      origin: "lock",
    })
    expect(selectProfile(lock, "first").location).toEqual({
      kind: "download",
      file: "example.gguf",
      source: "https://example.invalid/rev/abc/example.gguf",
    })
  })

  it("rejects an unknown profile id, naming the ids there are", () => {
    expect(() => selectProfile(lock, "qwen")).toThrow(
      'unknown model profile "qwen"; the profiles are first, second'
    )
  })

  it("picks the build for a platform, and names the platforms when there is none", () => {
    expect(selectBuild(lock, "win32-x64").asset).toBe(
      "llama-b100-bin-win-vulkan-x64.zip"
    )
    expect(() => selectBuild(lock, "linux-x64")).toThrow(
      "model.lock has no llama.cpp build for linux-x64; it has darwin-arm64, win32-x64"
    )
  })

  it("accepts a Windows path for a local profile", () => {
    const text = valid.replace(
      /^path: .*$/m,
      "path: C:\\Users\\u\\.ollama\\models\\blobs\\sha256-x"
    )
    expect(selectProfile(parseLock(text), "second").location).toEqual({
      kind: "local",
      path: "C:\\Users\\u\\.ollama\\models\\blobs\\sha256-x",
    })
  })

  it("keeps a value that itself contains a colon", () => {
    expect(selectProfile(lock, "first").location).toMatchObject({
      source: "https://example.invalid/rev/abc/example.gguf",
    })
  })
})

describe("modelPathOf", () => {
  const lock = parseLock(valid)

  it("joins a downloaded file onto the model directory with the platform's join", () => {
    const first = selectProfile(lock, "first")
    expect(modelPathOf(first, "/m")).toBe("/m/example.gguf")
    expect(modelPathOf(first, "C:\\m", (...p) => p.join("\\"))).toBe(
      "C:\\m\\example.gguf"
    )
  })

  it("uses a local path as it is", () => {
    expect(modelPathOf(selectProfile(lock, "second"), "/m")).toBe(
      `/Users/u/.ollama/models/blobs/sha256-${A}`
    )
  })
})

describe("parseLock rejects", () => {
  it.each([
    [
      "a missing release key",
      valid.replace(/^llama_cpp_commit: .*\n/m, ""),
      "model.lock is missing llama_cpp_commit",
    ],
    [
      "a missing profile key",
      valid.replace(/^size: 1234\n/m, ""),
      "model.lock profile first is missing size",
    ],
    [
      "a missing build key",
      valid.replace(/^sha256: b+\n/m, ""),
      "model.lock build darwin-arm64 is missing sha256",
    ],
    [
      "an unknown key in a profile",
      `${valid}revision: x\n`,
      'unknown key "revision" in profile second',
    ],
    [
      "a profile key before the first section",
      `size: 5\n${valid}`,
      'unknown key "size" before the first section',
    ],
    ["a repeated key", `${valid}size: 5\n`, "size appears twice"],
    ["an empty value", replace("model", "model:"), "model is empty"],
    ["a line without a key", `${valid}just text\n`, 'expected "key: value"'],
    [
      "a repeated profile",
      `${valid}[profile first]\n`,
      "profile first appears twice",
    ],
    [
      "a profile id with capitals",
      valid.replace("[profile first]", "[profile First]"),
      'profile id must be lowercase letters, digits, dots, dashes or underscores, not "First"',
    ],
    [
      "a build not named platform-arch",
      valid.replace("[build win32-x64]", "[build windows]"),
      'build must be named <platform>-<arch>, such as darwin-arm64, not "windows"',
    ],
    [
      "a repeated build",
      valid.replace("[build win32-x64]", "[build darwin-arm64]"),
      "build darwin-arm64 appears twice",
    ],
    [
      "an asset that is not an archive",
      valid
        .replace(
          "asset: llama-b100-bin-win-vulkan-x64.zip",
          "asset: llama-b100.exe"
        )
        .replace("/llama-b100-bin-win-vulkan-x64.zip", "/llama-b100.exe"),
      "build win32-x64: asset must be a .tar.gz or a .zip",
    ],
    [
      "an asset from another build",
      valid.replaceAll(
        "llama-b100-bin-win-vulkan-x64.zip",
        "llama-b99-bin-win-vulkan-x64.zip"
      ),
      "build win32-x64: asset llama-b99-bin-win-vulkan-x64.zip is not from b100",
    ],
    [
      "a build source for another asset",
      valid.replace(
        "https://example.invalid/b100/llama-b100-bin-macos-arm64.tar.gz",
        "https://example.invalid/b100/other.tar.gz"
      ),
      "build darwin-arm64: source must be an https URL ending in /llama-b100-bin-macos-arm64.tar.gz",
    ],
    [
      "no build",
      valid.replace(/\[build[\s\S]*?(?=\[profile first\])/, ""),
      "model.lock has no [build] section",
    ],
    [
      "no profile",
      valid.slice(0, valid.indexOf("[profile first]")),
      "model.lock has no [profile] section",
    ],
    [
      "a default that is not a profile",
      replace("default_profile", "default_profile: third"),
      'default_profile "third" is not a profile in model.lock',
    ],
    [
      "a short sha256",
      valid.replace(
        `sha256: ${A}\nchat_template_marker: <|start`,
        "sha256: abc\nchat_template_marker: <|start"
      ),
      "profile first: sha256 must be 64 lowercase hex",
    ],
    [
      "an uppercase build sha256",
      valid.replace(`sha256: ${B}`, `sha256: ${"B".repeat(64)}`),
      "build darwin-arm64: sha256 must be 64 lowercase hex",
    ],
    [
      "a path as file",
      replace("file", "file: ../x.gguf"),
      "profile first: file must be a bare file name",
    ],
    [
      "a dot-dot file",
      replace("file", "file: .."),
      "profile first: file must be a bare file name",
    ],
    [
      "both file and path",
      valid.replace(
        "file: example.gguf",
        "file: example.gguf\npath: /m/x.gguf"
      ),
      "model.lock profile first: set file or path, not both",
    ],
    [
      "a relative path",
      valid.replace(/^path: .*$/m, "path: models/x.gguf"),
      'path must be absolute and normalized, not "models/x.gguf"',
    ],
    [
      "a path with ..",
      valid.replace(/^path: .*$/m, "path: /m/../x.gguf"),
      'path must be absolute and normalized, not "/m/../x.gguf"',
    ],
    [
      "a source on a local path",
      valid.replace(
        /^path: .*$/m,
        "path: /m/x.gguf\nsource: https://example.invalid/x.gguf"
      ),
      "profile second: a local path has no source",
    ],
    [
      "a file without a source",
      valid.replace(
        "source: https://example.invalid/rev/abc/example.gguf\n",
        ""
      ),
      "model.lock profile first is missing source",
    ],
    [
      "an http source",
      valid.replace(
        "source: https://example.invalid/rev/abc/example.gguf",
        "source: http://example.invalid/example.gguf"
      ),
      "profile first: source must be an https URL ending in /example.gguf",
    ],
    [
      "a source for another file",
      valid.replace(
        "source: https://example.invalid/rev/abc/example.gguf",
        "source: https://example.invalid/other.gguf"
      ),
      "ending in /example.gguf",
    ],
    [
      "a fractional size",
      replace("size", "size: 12.5"),
      "profile first: size must be a whole number",
    ],
    ["a zero size", replace("size", "size: 0"), "size must be a whole number"],
    [
      "an unsafe size",
      replace("size", "size: 99999999999999999999"),
      "size must be a whole number",
    ],
    [
      "kwargs that are not JSON",
      replace(
        "chat_template_kwargs",
        "chat_template_kwargs: {enable_thinking}"
      ),
      "profile second: chat_template_kwargs must be a JSON object",
    ],
    [
      "kwargs that are a JSON array",
      replace("chat_template_kwargs", "chat_template_kwargs: [1]"),
      "profile second: chat_template_kwargs must be a JSON object",
    ],
    [
      "a flag that moves the bind",
      replace("flags", "flags: --host 0.0.0.0"),
      "profile second: flags may not set --host; the launcher does",
    ],
    [
      "a flag that loads another model, written with =",
      replace("flags", "flags: --model=/tmp/other.gguf"),
      "flags may not set --model",
    ],
    [
      "a flag that offloads to another machine",
      replace("flags", "flags: --rpc 10.0.0.2:50052"),
      "flags may not set --rpc",
    ],
    [
      "kwargs passed as a flag",
      replace("flags", "flags: --chat-template-kwargs {}"),
      "flags may not set --chat-template-kwargs",
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
  ])("%s", (_name, text, message) => {
    expect(() => parseLock(text)).toThrow(message)
  })
})

describe("verified in model.lock", () => {
  it("reads true and false, and treats a missing key as unverified", () => {
    expect(
      parseLock(replace("size", "size: 1234\nverified: true")).profiles[0]
        ?.verified
    ).toBe(true)
    expect(
      parseLock(replace("size", "size: 1234\nverified: false")).profiles[0]
        ?.verified
    ).toBe(false)
    expect(parseLock(valid).profiles[0]?.verified).toBe(false)
  })

  it("rejects any other value", () => {
    expect(() =>
      parseLock(replace("size", "size: 1234\nverified: yes"))
    ).toThrow("profile first: verified must be true or false")
  })

  it("needs a chat template marker", () => {
    const text = valid.replace(
      "chat_template_marker: <|start_header_id|>\n",
      ""
    )
    expect(() => parseLock(text)).toThrow(
      "model.lock profile first is missing chat_template_marker"
    )
  })
})

describe("the user's profiles file", () => {
  const NAME = "/stack/profiles.lock"
  const mine = `# llama add o/r m.gguf
[profile mine]
model: o/r
quantization: Q8_0
file: m.gguf
source: https://example.invalid/rev/abc/m.gguf
size: 9
sha256: ${C}
`

  it("reads profiles without a marker, as unverified user profiles", () => {
    expect(parseUserProfiles(mine, NAME)).toEqual([
      {
        id: "mine",
        model: "o/r",
        quantization: "Q8_0",
        location: {
          kind: "download",
          file: "m.gguf",
          source: "https://example.invalid/rev/abc/m.gguf",
        },
        size: 9,
        sha256: C,
        chatTemplateMarker: undefined,
        chatTemplateKwargs: undefined,
        flags: [],
        verified: false,
        origin: "user",
      },
    ])
  })

  it("names the file in its errors", () => {
    expect(() =>
      parseUserProfiles(mine.replace("size: 9\n", ""), NAME)
    ).toThrow("/stack/profiles.lock profile mine is missing size")
    expect(() => parseUserProfiles(`${mine}bogus: 1\n`, NAME)).toThrow(
      '/stack/profiles.lock line 9: unknown key "bogus" in profile mine'
    )
  })

  it("rejects a verified key, release keys and build sections", () => {
    expect(() => parseUserProfiles(`${mine}verified: true\n`, NAME)).toThrow(
      "/stack/profiles.lock profile mine: verified is for model.lock; llama check-template records a pass on this machine"
    )
    for (const text of [
      `default_profile: mine\n${mine}`,
      `${mine}[build darwin-arm64]\nasset: a.zip\n`,
    ])
      expect(() => parseUserProfiles(text, NAME)).toThrow(
        "/stack/profiles.lock holds [profile] sections only"
      )
  })

  it("adds the user's profiles after the lock's, keeping the default", () => {
    const lock = withUserProfiles(
      parseLock(valid),
      parseUserProfiles(mine, NAME),
      NAME
    )
    expect(lock.profiles.map((p) => `${p.id}:${p.origin}`)).toEqual([
      "first:lock",
      "second:lock",
      "mine:user",
    ])
    expect(lock.defaultProfile).toBe("second")
  })

  it("refuses a user profile with the id of a lock profile", () => {
    const clash = parseUserProfiles(
      mine.replace("[profile mine]", "[profile first]"),
      NAME
    )
    expect(() => withUserProfiles(parseLock(valid), clash, NAME)).toThrow(
      "/stack/profiles.lock: profile first is also in model.lock; rename one of them"
    )
  })
})
