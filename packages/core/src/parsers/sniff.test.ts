import { describe, expect, it } from "vitest"
import { formatOf, mismatch, normalizeMime, sniff } from "./sniff"

const bytes = (...values: number[]) => Uint8Array.from(values)
const PDF = new TextEncoder().encode("%PDF-1.7\n")
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)

describe("normalizeMime and formatOf", () => {
  it("drops parameters and case", () => {
    expect(normalizeMime(" Application/PDF; name=x.pdf")).toBe(
      "application/pdf"
    )
  })

  it.each([
    ["message/rfc822", "mime"],
    ["application/mbox", "mbox"],
    ["application/pdf", "pdf"],
    ["image/png", "image"],
    ["IMAGE/JPEG", "image"],
    ["image/tiff", "image"],
    ["image/x-portable-graymap", "image"],
    ["text/html", null],
    ["", null],
  ])("%s is parsed as %s", (mime, format) => {
    expect(formatOf(mime)).toBe(format)
  })
})

describe("sniff", () => {
  it.each([
    [PDF, "application/pdf"],
    [PNG, "image/png"],
    [bytes(0xff, 0xd8, 0xff, 0xe0), "image/jpeg"],
    [bytes(0x49, 0x49, 0x2a, 0x00), "image/tiff"],
    [bytes(0x4d, 0x4d, 0x00, 0x2a), "image/tiff"],
    [new TextEncoder().encode("P5\n1 1\n255\n"), "image/x-portable-graymap"],
    [new TextEncoder().encode("GIF89a"), "image/gif"],
    [bytes(0x50, 0x4b, 0x03, 0x04), "application/zip"],
    [new TextEncoder().encode("From: a@example.invalid"), null],
    [bytes(), null],
  ])("recognises %o as %s", (input, type) => {
    expect(sniff(input)).toBe(type)
  })
})

describe("mismatch", () => {
  it("accepts bytes that match the declared type", () => {
    expect(mismatch("application/pdf", PDF)).toBeNull()
    expect(mismatch("image/png", PNG)).toBeNull()
    expect(
      mismatch("message/rfc822", new TextEncoder().encode("Subject: x"))
    ).toBeNull()
  })

  it("rejects a binary format declared as mail", () => {
    expect(mismatch("message/rfc822", PDF)).toBe(
      "declared message/rfc822 but the bytes are application/pdf"
    )
    expect(mismatch("application/mbox", PNG)).toBe(
      "declared application/mbox but the bytes are image/png"
    )
  })

  it("rejects bytes of another type, or of no known type", () => {
    expect(mismatch("image/jpeg", PNG)).toBe(
      "declared image/jpeg but the bytes are image/png"
    )
    expect(mismatch("application/pdf", new TextEncoder().encode("hello"))).toBe(
      "declared application/pdf but the bytes are not that format"
    )
  })
})
