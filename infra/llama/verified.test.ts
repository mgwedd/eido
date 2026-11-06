import { describe, expect, it } from "vitest"

import { hasPass, withPass } from "./verified.ts"

const A = "a".repeat(64)
const B = "b".repeat(64)
const qwen = { id: "qwen", sha256: A }

describe("hasPass", () => {
  const record = `gemma ${B} b100\nqwen ${A} b100\n`

  it("finds a line with the profile's id, hash and build", () => {
    expect(hasPass(record, qwen, "b100")).toBe(true)
  })

  it("does not count a pass for another build, another file or another id", () => {
    expect(hasPass(record, qwen, "b101")).toBe(false)
    expect(hasPass(record, { id: "qwen", sha256: B }, "b100")).toBe(false)
    expect(hasPass(`gemma ${A} b100\n`, qwen, "b100")).toBe(false)
    expect(hasPass("", qwen, "b100")).toBe(false)
  })
})

describe("withPass", () => {
  it("starts a record", () => {
    expect(withPass("", qwen, "b100")).toBe(`qwen ${A} b100\n`)
  })

  it("replaces the profile's earlier line and keeps the others", () => {
    expect(withPass(`qwen ${B} b99\n\ngemma ${B} b100\n`, qwen, "b100")).toBe(
      `gemma ${B} b100\nqwen ${A} b100\n`
    )
  })
})
