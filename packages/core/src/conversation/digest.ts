import { DEFAULT_SUMMARY_CHUNK_TOKENS, summarizeTurns } from "./compact"
import type { CompactDeps, SummaryStart } from "./compact"
import { fingerprintTurns } from "./fingerprint"
import type { ConversationStore } from "./store"
import type { CompactError, RawTurn } from "./types"

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
 * The old digest's summary when it covers a leading run of `turns` unchanged, so a resumed
 * conversation's rebuild sends only the turns added since. Raw turns are append-only, so this
 * holds unless the stored digest came from other turns.
 */
function resumable(
  store: ConversationStore,
  conversationId: string,
  turns: readonly RawTurn[]
): SummaryStart | undefined {
  const start = store.digestStart(conversationId)
  const digest = store.getConversationDigest(conversationId)
  if (start === undefined || digest === undefined) return undefined
  if (start.coveredTurns <= 0 || start.coveredTurns > turns.length) {
    return undefined
  }
  const covered = fingerprintTurns(turns.slice(0, start.coveredTurns))
  return covered === digest.parentRawFingerprint ? start : undefined
}

/**
 * The idle job: every conversation idle past the TTL with no digest of its current raw
 * transcript gets its final compaction through the background lane, stored as its one digest
 * (superseding an older one). A digest is stamped with the fingerprint of the turns it
 * summarized, so a turn that arrives mid-build leaves it stale rather than wrong. Rolling
 * in-flight compactions are never stored. A rebuild after a resume folds only the new turns
 * into the old digest's summary.
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
    const summarized = await summarizeTurns(
      turns,
      { queue: deps.queue, lane: "background" },
      DEFAULT_SUMMARY_CHUNK_TOKENS,
      resumable(store, conversationId, turns)
    )
    if (!summarized.ok) {
      result.failed.push({ conversationId, error: summarized.error })
      continue
    }
    store.putDigest(
      conversationId,
      summarized.text,
      fingerprintTurns(turns),
      deps.now().toISOString(),
      { summary: summarized.summary, coveredTurns: turns.length }
    )
    result.built.push(conversationId)
  }
  return result
}
