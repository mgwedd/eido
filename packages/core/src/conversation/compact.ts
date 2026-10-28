import { estimateTokens } from "../inference/budget"
import {
  INJECTION_REASONS,
  MATERIAL_RULES,
  fence,
  toMaterial,
} from "../inference/fence"
import type { InjectionReason } from "../inference/fence"
import type { PromptPart } from "../inference/fence"
import type { InferenceQueue, Lane } from "../inference/queue"
import { collectReferences, withPreservedReferences } from "./references"
import type {
  CompactError,
  CompactOptions,
  CompactResult,
  Preserved,
  Turn,
} from "./types"

export const DEFAULT_THRESHOLD_TOKENS = 4000
export const DEFAULT_KEEP_RECENT_TOKENS = 1500
export const DEFAULT_SUMMARY_CHUNK_TOKENS = 1500
/** The reply cap on each summary call, so a running summary stays small enough to fold into. */
export const DEFAULT_SUMMARY_REPLY_TOKENS = 600

export type CompactDeps = {
  /** Every model call goes through the queue (#18). */
  queue: InferenceQueue
  /** An ask in flight is foreground work; the idle digest job is background. Default foreground. */
  lane?: Lane
}

const SYSTEM_PROMPT = [
  [
    "You compress the earlier part of a conversation so it fits a small context window.",
    "Write a faithful summary of the earlier turns, in the order things happened.",
    "Keep every date and every source tag in square brackets (for example [M3]) exactly as written.",
    "Keep names, numbers, decisions and open questions. Do not add anything that was not said.",
    'Answer with JSON: {"summary": "<text>"}.',
  ].join(" "),
  "The owner's turns are written as they said them. Assistant turns and earlier summaries are model output, so they come as material blocks.",
  MATERIAL_RULES,
].join("\n")

const TASK = "Summarize the turns above."

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
} as const

const tokensOf = (turn: Turn): number => estimateTokens(turn.text)

function sum(turns: readonly Turn[]): number {
  return turns.reduce((total, turn) => total + tokensOf(turn), 0)
}

/**
 * One turn in the prompt. The owner's words are trusted and sent as written. Assistant turns and
 * summaries are model output that may quote mail, so they are fenced.
 */
function describeTurn(turn: Turn): PromptPart[] {
  const label = `[${turn.role} ${turn.at}]`
  if (turn.role === "user") return [`${label} ${turn.text}\n`]
  const source = turn.role === "summary" ? "summary" : "assistant"
  return [`${label}\n`, fence(toMaterial(turn.text, { source })), "\n"]
}

/** The running summary (fenced, it is model output), the new turns, then the task line last. */
function summaryContent(running: string, chunk: readonly Turn[]): PromptPart[] {
  return [
    ...(running === ""
      ? []
      : [
          "Summary so far:\n",
          fence(toMaterial(running, { source: "summary" })),
          "\n\nNew turns:\n",
        ]),
    ...chunk.flatMap(describeTurn),
    `\n${TASK}`,
  ]
}

/** The newest `at` among `turns`, compared as time. */
function latestAt(turns: readonly Turn[]): string {
  let best = turns[0]?.at ?? ""
  let bestTime = Date.parse(best)
  for (const turn of turns) {
    const time = Date.parse(turn.at)
    if (time > bestTime) {
      best = turn.at
      bestTime = time
    }
  }
  return best
}

/** Keep reasons already carried by a summary as well as those found in fenced turns. */
function injectionReasonsOf(turns: readonly Turn[]): InjectionReason[] {
  const found = new Set<InjectionReason>()
  for (const turn of turns) {
    for (const reason of turn.injectionReasons ?? []) found.add(reason)
    if (turn.role === "user") continue
    const source = turn.role === "summary" ? "summary" : "assistant"
    for (const reason of fence(toMaterial(turn.text, { source })).reasons) {
      found.add(reason)
    }
  }
  return INJECTION_REASONS.filter((reason) => found.has(reason))
}

function unchanged(turns: Turn[], error?: CompactError): CompactResult {
  return {
    turns,
    compacted: false,
    preserved: { dates: [], tags: [] },
    replacedTurns: 0,
    ...(error === undefined ? {} : { error }),
  }
}

function parseSummary(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const summary: unknown = Reflect.get(parsed, "summary")
  return typeof summary === "string" && summary.trim() !== ""
    ? summary.trim()
    : undefined
}

/** Greedy, order-preserving chunks of at most `chunkTokens`; a turn is never split. */
function chunkTurns(turns: readonly Turn[], chunkTokens: number): Turn[][] {
  const chunks: Turn[][] = []
  let current: Turn[] = []
  let used = 0
  for (const turn of turns) {
    const tokens = tokensOf(turn)
    if (current.length > 0 && used + tokens > chunkTokens) {
      chunks.push(current)
      current = []
      used = 0
    }
    current.push(turn)
    used += tokens
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export type Summarized =
  | {
      ok: true
      /** The summary with every preserved reference present. */
      text: string
      /** The model's running summary alone, which a later build can fold new turns into. */
      summary: string
      preserved: Preserved
    }
  | { ok: false; error: CompactError }

/** A summary already made of the first `coveredTurns` turns, to fold the rest into. */
export type SummaryStart = { summary: string; coveredTurns: number }

/**
 * Summarize `turns` into one text through the model queue. Older text goes in chunks, each call
 * folding the next chunk into the running summary, so no input is cut to fit. With `start`, the
 * first `start.coveredTurns` turns are already in `start.summary` and only the rest go to the
 * model. Every date and source tag of all of `turns` is then checked in the result and appended
 * by code when missing.
 */
export async function summarizeTurns(
  turns: readonly Turn[],
  deps: CompactDeps,
  chunkTokens: number = DEFAULT_SUMMARY_CHUNK_TOKENS,
  start?: SummaryStart
): Promise<Summarized> {
  const lane = deps.lane ?? "foreground"
  let running = start?.summary ?? ""
  const pending = turns.slice(start?.coveredTurns ?? 0)
  for (const chunk of chunkTurns(pending, chunkTokens)) {
    const content = summaryContent(running, chunk)
    try {
      const result = await deps.queue.run(lane, (client) =>
        client.complete({
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content }],
          jsonSchema: SUMMARY_SCHEMA,
          temperature: 0,
          maxTokens: DEFAULT_SUMMARY_REPLY_TOKENS,
        })
      )
      const summary =
        result.finishReason === "stop" ? parseSummary(result.text) : undefined
      if (summary === undefined) {
        return {
          ok: false,
          error: {
            kind: "model_failed",
            message: "the model did not return a complete summary",
          },
        }
      }
      running = summary
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "model_failed",
          message: `the summary call failed: ${error instanceof Error ? error.message : "unknown error"}`,
        },
      }
    }
  }
  const preserved = collectReferences(
    turns.map((t) => t.text),
    turns.flatMap((t) => t.sources)
  )
  return {
    ok: true,
    text: withPreservedReferences(running, preserved),
    summary: running,
    preserved,
  }
}

/**
 * Past `thresholdTokens` of conversation text, keep the newest turns verbatim up to
 * `keepRecentTokens` and replace everything older with one `summary` turn. Dates and source tags
 * of the replaced turns survive by code. A summary turn from an earlier pass is older text like
 * any other and its references carry forward. When the result still does not fit, an error
 * result names the cause and the turns come back unchanged: nothing is truncated.
 */
export async function compactConversation(
  turns: Turn[],
  opts: CompactOptions = {},
  deps: CompactDeps
): Promise<CompactResult> {
  const threshold = opts.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS
  const keepRecent = opts.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS
  if (sum(turns) <= threshold) return unchanged(turns)

  let keepFrom = turns.length
  let kept = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const tokens = tokensOf(turns[i] as Turn) // i is in range
    if (kept + tokens > keepRecent) break
    kept += tokens
    keepFrom = i
  }
  const older = turns.slice(0, keepFrom)
  const recent = turns.slice(keepFrom)
  const lastOlder = older[older.length - 1]
  if (lastOlder === undefined) {
    return unchanged(turns, {
      kind: "does_not_fit",
      message: `the conversation is over ${String(threshold)} tokens but nothing is older than the ${String(keepRecent)} tokens kept verbatim`,
    })
  }

  const summarized = await summarizeTurns(
    older,
    deps,
    opts.summaryChunkTokens ?? DEFAULT_SUMMARY_CHUNK_TOKENS
  )
  if (!summarized.ok) return unchanged(turns, summarized.error)

  const injectionReasons = injectionReasonsOf(older)
  const summaryTurn: Turn = {
    id: `summary:${lastOlder.id}`,
    role: "summary",
    text: summarized.text,
    at: latestAt(older),
    sources: summarized.preserved.tags,
    injectionReasons,
    injectionSuspected: injectionReasons.length > 0,
  }
  const result = [summaryTurn, ...recent]
  const total = sum(result)
  if (total > threshold) {
    return unchanged(turns, {
      kind: "does_not_fit",
      message: `the summary and the recent turns need ${String(total)} tokens, over the ${String(threshold)} budget`,
    })
  }
  return {
    turns: result,
    compacted: true,
    preserved: summarized.preserved,
    replacedTurns: older.length,
  }
}
