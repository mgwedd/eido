const encoder = new TextEncoder()

/** Unpadded base64url, the encoding the gate expects for every binary field. */
export function toBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/**
 * The challenge the device signs to approve one intent: SHA-256 over the UTF-8 bytes of the
 * RFC 8785 canonical JSON array `[payloadHash, intentId, nonce]` (decided in #85). The gate
 * builds the same bytes in `approvalChallenge`; the shared vectors keep the two in step.
 * `JSON.stringify` of an array of strings is already RFC 8785 output: no whitespace, and
 * strings escaped the same way.
 */
export async function buildChallenge(parts: {
  payloadHash: string
  intentId: string
  nonce: string
}): Promise<Uint8Array> {
  const text = JSON.stringify([parts.payloadHash, parts.intentId, parts.nonce])
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(text))
  )
}

/** "14ac 090f": the first eight hex characters of a payload hash, grouped 4+4. */
export function shortHash(hash: string): string {
  return `${hash.slice(0, 4)} ${hash.slice(4, 8)}`
}
