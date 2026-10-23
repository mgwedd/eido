// Conversation types. The raw transcript (user and assistant turns) is authoritative and kept;
// `summary` turns exist only in flight, built per request for the model's small context.

export type TurnRole = "user" | "assistant" | "summary"

export type Turn = {
  id: string
  role: TurnRole
  text: string
  /** ISO 8601. */
  at: string
  /** Source tags used in the turn, for example "M3". */
  sources: string[]
}

/** A turn as stored: only the roles a person or the model actually produced. */
export type RawTurn = Turn & { role: "user" | "assistant" }

export type CompactOptions = {
  /** Compaction starts above this many estimated tokens. Default 4000. */
  thresholdTokens?: number
  /** Most recent turns kept verbatim up to this many estimated tokens. Default 1500. */
  keepRecentTokens?: number
  /** Older text goes to the model in chunks of at most this many estimated tokens. Default 1500. */
  summaryChunkTokens?: number
}

export type Preserved = { dates: string[]; tags: string[] }

export type CompactErrorKind =
  /** The summary plus the kept turns still exceed the budget. Nothing was cut. */
  | "does_not_fit"
  /** The model call failed, was refused as too large, or answered something unusable. */
  | "model_failed"

export type CompactError = { kind: CompactErrorKind; message: string }

export type CompactResult = {
  /** The turns for the model. On an error, the input turns unchanged. */
  turns: Turn[]
  compacted: boolean
  preserved: Preserved
  /** How many turns the summary replaced. */
  replacedTurns: number
  error?: CompactError
}

export type SearchKind = "raw" | "digest"

export type SearchHit = {
  conversationId: string
  turnId?: string
  kind: SearchKind
  snippet: string
  score: number
}

export type ConversationDigest = {
  conversationId: string
  fingerprint: string
  parentRawFingerprint: string
  text: string
  createdAt: string
}

export type SourceTag = { tag: string; sourceRef: string }
