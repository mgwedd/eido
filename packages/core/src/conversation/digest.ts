import { summarizeTurns } from "./compact"
import type { CompactDeps } from "./compact"
import { fingerprintTurns } from "./fingerprint"
import type { ConversationStore } from "./store"
import type { CompactError } from "./types"

/** `conversation.digestIdleTtlMinutes`: how long a conversation is idle before its digest is built. */
export const DEFAULT_DIGEST_IDLE_TTL_MINUTES = 60

export type ConversationConfig = { digestIdleTtlMinutes?: number }

export type DigestSweepDeps = {
  queue: CompactDeps["queue"]
  now: () => Date
  config?: ConversationConfig
}

export type DigestSweepResult = {
  /** Conversations whose digest was stored or replaced. */
  built: string[]
  failed: { conversationId: string; error: CompactError }[]
}

/**
 * The idle job: every conversation idle past the TTL with no digest of its current raw
 * transcript gets its final compaction through the background lane, stored as its one digest
 * (superseding an older one). A digest is stamped with the fingerprint of the turns it
 * summarized, so a turn that arrives mid-build leaves it stale rather than wrong. Rolling
 * in-flight compactions are never stored.
 */
export async function runDigestSweep(
  store: ConversationStore,
  deps: DigestSweepDeps
): Promise<DigestSweepResult> {
  const ttl =
    deps.config?.digestIdleTtlMinutes ?? DEFAULT_DIGEST_IDLE_TTL_MINUTES
  const result: DigestSweepResult = { built: [], failed: [] }
  for (const conversationId of store.dueForDigest(deps.now(), ttl)) {
    const turns = store.getTurns(conversationId)
    const summarized = await summarizeTurns(turns, {
      queue: deps.queue,
      lane: "background",
    })
    if (!summarized.ok) {
      result.failed.push({ conversationId, error: summarized.error })
      continue
    }
    store.putDigest(
      conversationId,
      summarized.text,
      fingerprintTurns(turns),
      deps.now().toISOString()
    )
    result.built.push(conversationId)
  }
  return result
}
