import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { canonicalize, hashCanonicalString, payloadHash } from "./canonical.js"

interface ValidVector {
  id: string
  inputJson: string
  canonical: string
  sha256: string
}
interface InvalidVector {
  id: string
  inputJson: string
  reason: string
}
interface VectorFile {
  version: number
  valid: ValidVector[]
  invalid: InvalidVector[]
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../schemas/vectors/jcs-vectors.json", import.meta.url),
    "utf8"
  )
) as VectorFile // test fixture owned by this repo, not external input

describe("shared JCS vectors", () => {
  it.each(vectors.valid)("canonicalizes and hashes $id", (vector) => {
    const input: unknown = JSON.parse(vector.inputJson)
    expect(canonicalize(input)).toBe(vector.canonical)
    expect(payloadHash(input)).toBe(vector.sha256)
    expect(hashCanonicalString(vector.canonical)).toBe(vector.sha256)
  })

  it.each(vectors.invalid)("rejects $id", (vector) => {
    expect(() => canonicalize(JSON.parse(vector.inputJson))).toThrow(
      /lone surrogate/
    )
  })
})

describe("canonicalize", () => {
  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["undefined", undefined],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a bigint", 10n],
    ["undefined inside an object", { a: undefined }],
    ["a Date", new Date(0)],
  ])("throws on %s", (_name, input) => {
    expect(() => canonicalize(input)).toThrow(/canonicalize:/)
  })

  it("sorts keys by UTF-16 code units, not code points", () => {
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FB33; by code point it would sort after.
    const out = canonicalize({ "\uFB33": 1, "\u{1F600}": 2 })
    expect(out).toBe('{"\u{1F600}":2,"\uFB33":1}')
  })

  it("is stable across key insertion order", () => {
    const a: Record<string, unknown> = {}
    a["x"] = 1
    a["y"] = { q: 1, p: 2 }
    const b: Record<string, unknown> = {}
    b["y"] = { p: 2, q: 1 }
    b["x"] = 1
    expect(canonicalize(a)).toBe(canonicalize(b))
    expect(payloadHash(a)).toBe(payloadHash(b))
  })

  it("accepts null-prototype objects", () => {
    const o = Object.assign(Object.create(null) as Record<string, unknown>, {
      b: 1,
      a: 2,
    })
    expect(canonicalize(o)).toBe('{"a":2,"b":1}')
  })
})
