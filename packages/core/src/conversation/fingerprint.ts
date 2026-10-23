import { createHash } from "node:crypto"
import { fingerprintConversation } from "../digest/fingerprint"
import type { Turn } from "./types"

// The fingerprint rules belong to #48's digest module; conversation only hashes its stored turns.
export {
  deriveDigestFingerprint,
  fingerprintConversation,
} from "../digest/fingerprint"

/** The fingerprint of stored raw turns. */
export function fingerprintTurns(turns: readonly Turn[]): string {
  return fingerprintConversation(
    turns.map((t) => ({
      id: t.id,
      textSha256: createHash("sha256").update(t.text).digest("hex"),
    }))
  )
}
