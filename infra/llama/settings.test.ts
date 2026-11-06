import { describe, expect, it } from "vitest"

import { MODEL_KEY, readSetting, withSetting } from "./settings.ts"

describe("readSetting", () => {
  it("reads the key from KEY=value lines, quoted or not", () => {
    expect(readSetting("A=1\nEIDO_LLAMA_MODEL=qwen\n", MODEL_KEY)).toBe("qwen")
    expect(readSetting('EIDO_LLAMA_MODEL="gemma"\n', MODEL_KEY)).toBe("gemma")
  })

  it("treats a missing or blank key as unset", () => {
    expect(readSetting("A=1\n", MODEL_KEY)).toBeUndefined()
    expect(readSetting("EIDO_LLAMA_MODEL=\n", MODEL_KEY)).toBeUndefined()
  })
})

describe("withSetting", () => {
  it("replaces only the key's line and keeps every other line, comments included", () => {
    const text =
      "# stack settings\nEIDO_PUSH_VAPID_SUBJECT=mailto:a@example.invalid\nEIDO_LLAMA_MODEL=old\nEIDO_LLAMA_PORT=8080\n"
    expect(withSetting(text, MODEL_KEY, "new")).toBe(
      "# stack settings\nEIDO_PUSH_VAPID_SUBJECT=mailto:a@example.invalid\nEIDO_LLAMA_MODEL=new\nEIDO_LLAMA_PORT=8080\n"
    )
  })

  it("appends the key when it is not there, and to an empty file", () => {
    expect(withSetting("A=1", MODEL_KEY, "x")).toBe("A=1\nEIDO_LLAMA_MODEL=x\n")
    expect(withSetting("", MODEL_KEY, "x")).toBe("EIDO_LLAMA_MODEL=x\n")
  })

  it("collapses repeated or exported assignments into one, and leaves look-alike keys", () => {
    expect(
      withSetting(
        "export EIDO_LLAMA_MODEL=a\nEIDO_LLAMA_MODEL_DIR=/m\n EIDO_LLAMA_MODEL = b\n",
        MODEL_KEY,
        "c"
      )
    ).toBe("EIDO_LLAMA_MODEL=c\nEIDO_LLAMA_MODEL_DIR=/m\n")
  })
})
