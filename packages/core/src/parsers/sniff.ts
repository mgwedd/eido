// Declared types are untrusted: a sender labels the attachment. The parser picks the format from
// the declared type and then checks that the bytes agree before handing them to a library.

export type Format = "mime" | "mbox" | "pdf" | "image"

const FORMATS: Readonly<Record<string, Format>> = {
  "message/rfc822": "mime",
  "application/mbox": "mbox",
  "application/pdf": "pdf",
  "image/png": "image",
  "image/jpeg": "image",
  "image/tiff": "image",
  "image/x-portable-graymap": "image",
}

/** `Type/Sub; param=x` becomes `type/sub`. */
export function normalizeMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase()
}

/** The format a declared type is parsed as, or null when it is not supported. */
export function formatOf(mime: string): Format | null {
  return FORMATS[normalizeMime(mime)] ?? null
}

const MAGIC: ReadonlyArray<{ type: string; bytes: readonly number[] }> = [
  { type: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  {
    type: "image/png",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/tiff", bytes: [0x49, 0x49, 0x2a, 0x00] }, // little-endian
  { type: "image/tiff", bytes: [0x4d, 0x4d, 0x00, 0x2a] }, // big-endian
  { type: "image/x-portable-graymap", bytes: [0x50, 0x35] }, // P5
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: "application/zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
]

/** The binary type the bytes start with, or null for text or an unknown format. */
export function sniff(bytes: Uint8Array): string | null {
  const hit = MAGIC.find(({ bytes: magic }) =>
    magic.every((byte, index) => bytes[index] === byte)
  )
  return hit?.type ?? null
}

/** Why the bytes do not match the declared type, or null when they do. */
export function mismatch(mime: string, bytes: Uint8Array): string | null {
  const declared = normalizeMime(mime)
  const actual = sniff(bytes)
  const format = formatOf(declared)
  if (format === "mime" || format === "mbox") {
    return actual === null
      ? null
      : `declared ${declared} but the bytes are ${actual}`
  }
  if (actual === declared) return null
  return `declared ${declared} but the bytes are ${actual ?? "not that format"}`
}
