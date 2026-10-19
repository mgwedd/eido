import { createHash } from "node:crypto"

// RFC 8785 (JCS) canonical JSON and payload hashing. The gate hashes the canonical form at
// proposal time and re-hashes the exact request body before calling upstream.
// The PWA and Swift implementations must match; the shared vectors live in
// packages/schemas/vectors/jcs-vectors.json.

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
}

function quote(text: string, what: string): string {
  if (LONE_SURROGATE.test(text)) {
    throw new Error(
      `canonicalize: ${what} contains a lone surrogate (not valid I-JSON)`
    )
  }
  return `"${text.replace(/[\u0000-\u001f"\\]/g, (ch) => SHORT_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Returns the RFC 8785 canonical JSON string; throws on values outside I-JSON. */
export function canonicalize(value: unknown): string {
  switch (typeof value) {
    case "string":
      return quote(value, "string value")
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `canonicalize: ${String(value)} is not representable in JSON`
        )
      }
      return JSON.stringify(value)
    case "boolean":
      return value ? "true" : "false"
    case "object":
      break
    default:
      throw new Error(
        `canonicalize: ${typeof value} is not representable in JSON`
      )
  }
  if (value === null) return "null"
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalize(item)).join(",")}]`
  }
  if (!isPlainObject(value)) {
    throw new Error(
      "canonicalize: only plain objects and arrays are representable in JSON"
    )
  }
  // Default sort compares UTF-16 code units, as RFC 8785 section 3.2.3 requires.
  const entries = Object.entries(value).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return `{${entries.map(([key, member]) => `${quote(key, "object key")}:${canonicalize(member)}`).join(",")}}`
}

/** Lowercase hex SHA-256 over the UTF-8 bytes of an already-canonical string. */
export function hashCanonicalString(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/** Lowercase hex SHA-256 of the canonical form of `value`. */
export function payloadHash(value: unknown): string {
  return hashCanonicalString(canonicalize(value))
}
