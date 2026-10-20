import { randomBytes } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

// Single-use approval nonces. Each pending intent holds exactly one current nonce
// (intents.current_nonce); issuing a new one supersedes the previous, so a nonce from an
// earlier card open can never be replayed. approval_nonces remembers every nonce ever issued,
// which intent it belongs to and when it was used, so a nonce is never valid twice.

/** 32 bytes from the CSPRNG as unpadded base64url (43 characters). */
export function newNonce(): string {
  return randomBytes(32).toString("base64url")
}

/** Issues a fresh nonce for the intent and makes it the current one. The caller holds the transaction. */
export function issueCurrentNonce(db: DatabaseSync, intentId: string): string {
  const nonce = newNonce()
  db.prepare(
    "INSERT INTO approval_nonces (nonce, intent_id, issued_at, used_at) VALUES (?, ?, ?, NULL)"
  ).run(nonce, intentId, new Date().toISOString())
  db.prepare("UPDATE intents SET current_nonce = ? WHERE id = ?").run(
    nonce,
    intentId
  )
  return nonce
}
