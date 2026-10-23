import { createHash } from "node:crypto"

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex")

// Fingerprints cover the RAW stored text: raw is the source of truth, and per-request
// compaction (#25) is never part of one. The JSON encoding of the (id, hash) pairs keeps the
// boundaries between fields unambiguous.
function fingerprintOrdered(
  domain: string,
  entries: readonly (readonly [string, string])[]
): string {
  return sha256Hex(`${domain}\0${JSON.stringify(entries)}`)
}

/** Ordered message ids and the hashes of their raw stored bodies. */
export function fingerprintThread(
  messages: readonly { id: string; bodySha256: string }[]
): string {
  return fingerprintOrdered(
    "thread",
    messages.map((m) => [m.id, m.bodySha256] as const)
  )
}

/** A document is identified by its content hash, which already is the raw fingerprint. */
export function fingerprintDocument(docSha256: string): string {
  return docSha256
}

/** Ordered turn ids and the hashes of the raw turn text (used by #49). */
export function fingerprintConversation(
  turns: readonly { id: string; textSha256: string }[]
): string {
  return fingerprintOrdered(
    "conversation",
    turns.map((t) => [t.id, t.textSha256] as const)
  )
}

/**
 * The fingerprint of a derived digest (a compacted conversation): the parent's raw fingerprint
 * and the digest text. Never a cache key; it only records what a stored digest was built from.
 */
export function deriveDigestFingerprint(
  parentRawFingerprint: string,
  digestText: string
): string {
  return sha256Hex(`${parentRawFingerprint}\0${digestText}`)
}

/** `sha256(promptVersion || '\0' || modelId || '\0' || fingerprint)` */
export function digestKey(
  promptVersion: string,
  modelId: string,
  fingerprint: string
): string {
  return sha256Hex(`${promptVersion}\0${modelId}\0${fingerprint}`)
}
