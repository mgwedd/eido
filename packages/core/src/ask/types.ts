import type { DatabaseSync } from "node:sqlite"
import type { InjectionReason } from "../inference/fence"
import type { InferenceQueue } from "../inference/queue"

/** What the model's first step asks code to run. Code runs it; the model never counts. */
export interface SearchPlan {
  terms: string[]
  /** Inclusive lower bound on `occurred_at`, an ISO 8601 date or date-time. */
  after?: string
  /** Exclusive upper bound on `occurred_at`, an ISO 8601 date or date-time. */
  before?: string
  wants: "count" | "find" | "summarize"
}

export interface AskCitation {
  /** The tag without brackets, such as `M3`. */
  tag: string
  /** sha256 of the cited document. */
  documentId: string
  source: string
  sourceRef: string
  title?: string
  occurredAt?: string
  /** From `fence`: the cited text looked like an injection attempt. The answer still used it. */
  injectionSuspected: boolean
  injectionReasons: InjectionReason[]
}

export interface AskCoverage {
  /** Indexed documents inside the plan's date filters. */
  searched: number
  /** Documents matching the plan: `facts.matchCount`, or 0 when nothing was counted. */
  matched: number
  /** Pack members the model read. */
  readInFull: number
  /** `read X of Y matching messages in full`, built by code. */
  label: string
}

export interface AskResult {
  status: "answered" | "no_match" | "refused"
  /** Invented citation tags removed; real tags kept as `[M3]`. */
  answer: string
  citations: AskCitation[]
  coverage: AskCoverage
  /** From `countMatches`, never from the model. Null when the ask was refused before counting. */
  facts: { matchCount: number | null }
  /** Invented tags removed from the answer, without brackets. */
  droppedTags: string[]
  /** The prompt-token tripwire fired on a model step. */
  possiblyTruncated: boolean
  /** Set when refused. */
  reason?: string
}

export interface AskDeps {
  /** The index (`openIndex`). */
  db: DatabaseSync
  /** The shared inference queue; the whole ask runs as one foreground job. */
  queue: InferenceQueue
  /** Context budget for the pack, from `ContextBudgets.ask`. */
  budgetTokens: number
  /** Characters per estimated token, as configured for the model client. */
  charsPerToken?: number
  /** How many search hits may extend the pack. Default 20. */
  searchLimit?: number
  /** The clock the plan's relative dates are resolved against. Default `new Date()`. */
  now?: () => Date
}
