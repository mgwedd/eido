import type { DatabaseSync } from "node:sqlite"
import type {
  AskCitation as SchemaAskCitation,
  AskCoverage as SchemaAskCoverage,
  CoreApiAskResponse,
} from "@eido/schemas"
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

export type AskCitation = SchemaAskCitation
export type AskCoverage = SchemaAskCoverage
export type AskResult = CoreApiAskResponse

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
