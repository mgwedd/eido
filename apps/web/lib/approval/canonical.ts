// RFC 8785 (JCS) canonical JSON and SHA-256 hashing for the device-side payload check (#94).
// The gate (packages/gate/src/internal/canonical.ts) and Swift produce the same bytes; the
// shared vectors in packages/schemas/vectors/jcs-vectors.json keep the three in step.

const encoder = new TextEncoder()

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

function quote(text: string): string {
  if (LONE_SURROGATE.test(text)) {
    throw new Error("canonicalize: a string holds a lone surrogate")
  }
  return `"${text.replace(
    /[\u0000-\u001f"\\]/g,
    (ch) =>
      SHORT_ESCAPES[ch] ??
      `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  )}"`
}

function canonicalText(value: unknown): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "string":
      return quote(value)
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("canonicalize: a number is not representable in JSON")
      }
      return JSON.stringify(value)
    case "boolean":
      return value ? "true" : "false"
    case "object":
      break
    default:
      throw new Error("canonicalize: value is not representable in JSON")
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalText(item)).join(",")}]`
  }
  // Default string comparison orders UTF-16 code units, as RFC 8785 section 3.2.3 requires.
  const entries = Object.entries(value).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return `{${entries
    .map(([key, member]) => `${quote(key)}:${canonicalText(member)}`)
    .join(",")}}`
}

/** The RFC 8785 canonical UTF-8 bytes of a JSON value; throws on values outside I-JSON. */
export function canonicalize(value: unknown): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(canonicalText(value)))
}

/** Lowercase hex SHA-256 of `bytes`, via Web Crypto. */
export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

/**
 * The hash the device computes over a payload the gate sent as JSON text: parse it, take the
 * RFC 8785 canonical bytes, SHA-256 them. Returns undefined when the text is not JSON or holds
 * a value outside I-JSON.
 */
export async function hashPayloadText(
  payload: string
): Promise<string | undefined> {
  try {
    return await sha256(canonicalize(JSON.parse(payload) as unknown))
  } catch {
    return undefined
  }
}
