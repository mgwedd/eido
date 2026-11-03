import type { DatabaseSync } from "node:sqlite"
import type {
  AskCitation as SchemaAskCitation,
  AskCoverage as SchemaAskCoverage,
  CoreApiAskResponse,
} from "@eido/schemas"
import type { InferenceQueue } from "../inference/queue"
import type { DigestService } from "../digest/service"
import type { Turn } from "../conversation/types"

/** What the model's first step asks code to run. Code runs it; the model never counts. */
export interface SearchPlan {
  terms: string[]
  /** Inclusive lower bound on `occurred_at`, an ISO 8601 date or date-time. */
  after?: string
  /** Exclusive upper bound on `occurred_at`, an ISO 8601 date or date-time. */
  before?: string
  wants: "count" | "find" | "summarize"
}

export type AskCitation = SchemaAskCitation
export type AskCoverage = SchemaAskCoverage
export type AskResult = CoreApiAskResponse

export interface AskDeps {
  /** The index (`openIndex`). */
  db: DatabaseSync
  /** The shared inference queue; the whole ask runs as one foreground job. */
  queue: InferenceQueue
  /**
   * The one input cap for each Ask model request, in estimated tokens. The answer request's
   * system prompt, conversation, facts, messages, question and `followUpReserveTokens` all fit
   * inside it; the plan request's system prompt, schema and question too.
   */
  budgetTokens: number
  /** Room inside `budgetTokens` kept free for a follow-up lookup. Default 256. */
  followUpReserveTokens?: number
  /** Characters per estimated token, as configured for the model client. */
  charsPerToken?: number
  /** How many search hits may extend the pack. Default 20. */
  searchLimit?: number
  /** The clock the plan's relative dates are resolved against. Default `new Date()`. */
  now?: () => Date
  /**
   * The stored digests. When set, a broad question whose best match is in a thread of several
   * messages reads the thread through `selectZoomContext`: ranked digest lines, then verified
   * raw passages. Unset, a broad question reads whole members as before.
   */
  digest?: Pick<DigestService, "getDigest">
  /** Compacted turns from this Ask conversation, included to resolve follow-up questions. */
  conversation?: readonly Turn[]
  /** Maps a document source to its stable tag in this conversation. */
  allocateSourceTag?: (sourceRef: string) => Promise<string>
}
