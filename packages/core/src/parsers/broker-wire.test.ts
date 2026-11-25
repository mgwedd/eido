import { describe, expect, it } from "vitest"
import {
  MAX_HEADER_BYTES,
  encodeHeader,
  frame,
  maxResponseBytes,
  readRequestHeader,
} from "./broker-wire"
import { DEFAULT_LIMITS } from "./types"

const SHA = "d".repeat(64)
const header = (over: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      mime: "application/pdf",
      sha256: SHA,
      bodyBytes: 12,
      limits: DEFAULT_LIMITS,
      ...over,
    })
  )

describe("frame and encodeHeader", () => {
  it("prefixes the payload with its length as four big-endian bytes", () => {
    expect([...frame(Buffer.from("abc"))]).toEqual([0, 0, 0, 3, 97, 98, 99])
  })

  it("encodes a header that reads back as the same request", () => {
    const encoded = encodeHeader({
      mime: "message/rfc822",
      sha256: SHA,
      limits: { ...DEFAULT_LIMITS, pdfPages: 7 },
      bodyBytes: 99,
    })
    expect(encoded.readUInt32BE(0)).toBe(encoded.length - 4)
    expect(readRequestHeader(encoded.subarray(4))).toEqual({
      mime: "message/rfc822",
      sha256: SHA,
      limits: { ...DEFAULT_LIMITS, pdfPages: 7 },
      bodyBytes: 99,
    })
  })

  it("keeps a header with the default limits well under the header cap", () => {
    expect(
      encodeHeader({
        mime: "x".repeat(255),
        sha256: SHA,
        limits: DEFAULT_LIMITS,
        bodyBytes: Number.MAX_SAFE_INTEGER,
      }).length - 4
    ).toBeLessThan(MAX_HEADER_BYTES)
  })
})

describe("readRequestHeader", () => {
  it("reads a valid header", () => {
    expect(readRequestHeader(header())).toEqual({
      mime: "application/pdf",
      sha256: SHA,
      bodyBytes: 12,
      limits: DEFAULT_LIMITS,
    })
  })

  it("accepts an empty body", () => {
    expect(readRequestHeader(header({ bodyBytes: 0 }))?.bodyBytes).toBe(0)
  })

  const invalid: Array<[string, Buffer]> = [
    ["JSON that does not parse", Buffer.from("{nope")],
    ["a JSON array", Buffer.from("[1]")],
    ["JSON null", Buffer.from("null")],
    ["another version", header({ version: 2 })],
    ["no version", header({ version: undefined })],
    ["a mime that is not a string", header({ mime: 5 })],
    ["a mime over 255 characters", header({ mime: "m".repeat(256) })],
    ["a sha256 of the wrong length", header({ sha256: "d".repeat(63) })],
    ["an uppercase sha256", header({ sha256: "D".repeat(64) })],
    ["a sha256 that is not a string", header({ sha256: 7 })],
    ["a fractional body size", header({ bodyBytes: 1.5 })],
    ["a negative body size", header({ bodyBytes: -1 })],
    ["a body size past the safe integers", header({ bodyBytes: 2 ** 53 })],
    ["a body size that is a string", header({ bodyBytes: "12" })],
    ["no limits", header({ limits: undefined })],
    ["limits that are not an object", header({ limits: 4 })],
    [
      "a limit left out",
      header({ limits: { ...DEFAULT_LIMITS, timeoutMs: undefined } }),
    ],
    [
      "a limit that is a string",
      header({ limits: { ...DEFAULT_LIMITS, heapMiB: "256" } }),
    ],
    ["a limit of zero", header({ limits: { ...DEFAULT_LIMITS, pdfPages: 0 } })],
    [
      "a fractional limit",
      header({ limits: { ...DEFAULT_LIMITS, inputBytes: 1.5 } }),
    ],
  ]
  for (const [name, bytes] of invalid) {
    it(`refuses ${name}`, () => {
      expect(readRequestHeader(bytes)).toBeNull()
    })
  }

  it("ignores fields it does not know, so they cannot reach the parse", () => {
    expect(readRequestHeader(header({ ocrBinary: "/usr/bin/evil" }))).toEqual({
      mime: "application/pdf",
      sha256: SHA,
      bodyBytes: 12,
      limits: DEFAULT_LIMITS,
    })
  })
})

describe("maxResponseBytes", () => {
  it("allows 16 bytes of JSON per output character plus one MiB for the offsets", () => {
    expect(maxResponseBytes({ ...DEFAULT_LIMITS, outputChars: 1000 })).toBe(
      16_000 + 1_048_576
    )
  })
})
