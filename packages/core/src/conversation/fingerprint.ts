import { createHash } from "node:crypto"
import type { Turn } from "./types"

// The fingerprint rules of #48, which owns them: the conversation fingerprint covers ordered ids
// and hashes of the RAW turn text; a digest fingerprint is derived from its parent and its text
// and never serves as a cache key. #48's `digest/` module is not on main yet, so the two
// functions live here with the same signatures until it lands.

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

export function fingerprintConversation(
  turns: readonly { id: string; textSha256: string }[]
): string {
  return sha256(turns.map((t) => `${t.id}\0${t.textSha256}`).join("\n"))
}

/** sha256(parent || '\0' || text); derived, not authoritative. */
export function deriveDigestFingerprint(
  parentRawFingerprint: string,
  digestText: string
): string {
  return sha256(`${parentRawFingerprint}\0${digestText}`)
}

/** The fingerprint of stored raw turns. */
export function fingerprintTurns(turns: readonly Turn[]): string {
  return fingerprintConversation(
    turns.map((t) => ({ id: t.id, textSha256: sha256(t.text) }))
  )
}
