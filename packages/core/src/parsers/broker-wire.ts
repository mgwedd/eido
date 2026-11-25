import { LIMIT_NAMES, resolveLimits } from "./types"
import type { ParseLimits } from "./types"

// The parser broker's wire format, shared by the server (broker.ts) and the core-side client
// (broker-client.ts). One request and one response per connection, each a length-prefixed frame:
//
//   request   u32be headerBytes | header JSON | body (header.bodyBytes bytes)
//   response  u32be resultBytes | ParseResult JSON
//
// The header is small and read first, so the broker can refuse an oversize body before it reads
// a byte of it. Everything read from a socket is parsed here, never cast.

export const WIRE_VERSION = 1

/** Largest header the broker reads. The header is a MIME type, a hash and eight numbers. */
export const MAX_HEADER_BYTES = 4096

const SHA256 = /^[0-9a-f]{64}$/
const MAX_MIME_CHARS = 255

export type RequestHeader = {
  mime: string
  /** The hash of the body; the broker checks it, so a truncated or altered body is caught. */
  sha256: string
  limits: ParseLimits
  bodyBytes: number
}

/** The largest result frame a client reads for these limits (JSON-escaped text plus offsets). */
export function maxResponseBytes(limits: ParseLimits): number {
  return limits.outputChars * 16 + 1024 * 1024
}

/** A frame: its length as four big-endian bytes, then the payload. */
export function frame(payload: Uint8Array): Buffer {
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32BE(payload.byteLength)
  return Buffer.concat([head, payload])
}

export function encodeHeader(header: RequestHeader): Buffer {
  return frame(
    Buffer.from(JSON.stringify({ version: WIRE_VERSION, ...header }), "utf8")
  )
}

/** The header the bytes hold, or null for anything that is not a version 1 request header. */
export function readRequestHeader(bytes: Uint8Array): RequestHeader | null {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  if (Reflect.get(value, "version") !== WIRE_VERSION) return null
  const mime: unknown = Reflect.get(value, "mime")
  const sha256: unknown = Reflect.get(value, "sha256")
  const bodyBytes: unknown = Reflect.get(value, "bodyBytes")
  const given: unknown = Reflect.get(value, "limits")
  if (typeof mime !== "string" || mime.length > MAX_MIME_CHARS) return null
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null
  if (typeof bodyBytes !== "number" || !Number.isSafeInteger(bodyBytes)) {
    return null
  }
  if (bodyBytes < 0) return null
  if (typeof given !== "object" || given === null) return null
  const limits: Partial<ParseLimits> = {}
  for (const name of LIMIT_NAMES) {
    const limit: unknown = Reflect.get(given, name)
    if (typeof limit !== "number") return null
    limits[name] = limit
  }
  try {
    return { mime, sha256, bodyBytes, limits: resolveLimits(limits) }
  } catch {
    return null
  }
}
