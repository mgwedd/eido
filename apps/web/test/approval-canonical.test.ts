import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { canonicalize, hashPayloadText, sha256 } from "@/lib/approval/canonical"

type JcsVectors = {
  valid: { id: string; inputJson: string; canonical: string; sha256: string }[]
  invalid: { id: string; inputJson: string }[]
}

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/schemas/vectors/jcs-vectors.json",
      import.meta.url
    ),
    "utf8"
  )
) as JcsVectors // test fixture owned by this repo, not external input

const decoder = new TextDecoder()

describe("canonicalize and sha256 against the shared JCS vectors", () => {
  it.each(vectors.valid)("matches $id", async (vector) => {
    const bytes = canonicalize(JSON.parse(vector.inputJson))
    expect(decoder.decode(bytes)).toBe(vector.canonical)
    expect(await sha256(bytes)).toBe(vector.sha256)
    expect(await hashPayloadText(vector.inputJson)).toBe(vector.sha256)
  })

  it.each(vectors.invalid)("refuses $id", async (vector) => {
    expect(() => canonicalize(JSON.parse(vector.inputJson))).toThrow()
    expect(await hashPayloadText(vector.inputJson)).toBeUndefined()
  })
})

describe("hashPayloadText", () => {
  it("changes when one byte of the payload changes", async () => {
    expect(await hashPayloadText('{"to":"a@example.invalid"}')).not.toBe(
      await hashPayloadText('{"to":"b@example.invalid"}')
    )
  })

  it("is undefined for text that is not JSON", async () => {
    expect(await hashPayloadText("{nope")).toBeUndefined()
  })
})
