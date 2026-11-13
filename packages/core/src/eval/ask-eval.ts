import { readFileSync } from "node:fs"
import { claimsAbsence } from "../ask/answer"
import { ANSWER_REMINDER, ANSWER_SYSTEM } from "../ask/ask"
import { COMPACTION_LEGEND } from "../context/compact"
import { blockParts } from "../context/pack-store"
import { fence, toMaterial } from "../inference/fence"
import type { InferenceRequest, ModelClient } from "../inference/types"

// Eval of the Ask answer step (issue #717). A case is one question over a few messages; the
// request is built the way `ask()` builds its final user turn, with or without ANSWER_REMINDER
// beside the question, and the model's reply is scored by plain functions:
//   - tag citation: every tag is a real `[M<n>]` of this case, none is malformed, and an
//     answerable case cites at least one source;
//   - placeholder use: the case's required `{matches}`, `{read}`, `{searched}` are written and
//     no count of messages is written as a number;
//   - "no match found": a no-match case says so and does not claim that something never happened.

export const PLACEHOLDERS = ["{matches}", "{read}", "{searched}"] as const

export type AskVariant = "with-reminder" | "without-reminder"
export const ASK_VARIANTS: readonly AskVariant[] = [
  "with-reminder",
  "without-reminder",
]

export interface AskEvalMessage {
  /** The tag line as the pack writes it, for example `[M1]`. */
  tag: string
  label: string
  body: string
}

export interface AskEvalCase {
  id: string
  question: string
  /** `answer`: the messages answer it. `no_match`: they do not. */
  kind: "answer" | "no_match"
  wants: "count" | "find"
  counts: { matched: number; searched: number; readInFull: number }
  messages: AskEvalMessage[]
  /** The tags of the messages that answer the question; at least one must be cited. */
  sources: string[]
  /** Placeholders the answer must write. */
  placeholders: string[]
}

export interface AskCaseScore {
  id: string
  tagCitation: boolean
  placeholderUse: boolean
  /** Null when the case is not a no-match case. */
  noMatchPhrasing: boolean | null
  answer: string
}

export interface AskScores {
  tagCitation: number
  placeholderUse: number
  /** Over the no-match cases only. */
  noMatchPhrasing: number
}

export interface AskEvalReport {
  variant: AskVariant
  scores: AskScores
  cases: AskCaseScore[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "")
    return fail(path, "expected a non-empty string")
  return value
}

function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return fail(path, "expected a non-negative integer")
  return value
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return fail(path, "expected an array")
  return value.map((item, i) => str(item, `${path}[${String(i)}]`))
}

export function parseAskCase(raw: unknown, path: string): AskEvalCase {
  if (!isRecord(raw)) return fail(path, "expected an object")
  const kind = raw["kind"]
  if (kind !== "answer" && kind !== "no_match")
    return fail(`${path}.kind`, "expected answer or no_match")
  const wants = raw["wants"]
  if (wants !== "count" && wants !== "find")
    return fail(`${path}.wants`, "expected count or find")
  const counts = raw["counts"]
  if (!isRecord(counts)) return fail(`${path}.counts`, "expected an object")
  const messagesRaw = raw["messages"]
  if (!Array.isArray(messagesRaw) || messagesRaw.length === 0)
    return fail(`${path}.messages`, "expected a non-empty array")
  const messages = messagesRaw.map((item: unknown, i): AskEvalMessage => {
    const at = `${path}.messages[${String(i)}]`
    if (!isRecord(item)) return fail(at, "expected an object")
    const tag = str(item["tag"], `${at}.tag`)
    if (!/^\[M\d+\]$/.test(tag)) fail(`${at}.tag`, "expected a tag like [M1]")
    return {
      tag,
      label: str(item["label"], `${at}.label`),
      body: str(item["body"], `${at}.body`),
    }
  })
  const sources = strings(raw["sources"], `${path}.sources`)
  const tags = new Set(messages.map((m) => m.tag))
  for (const source of sources) {
    if (!tags.has(source))
      fail(`${path}.sources`, `${source} is not a message tag`)
  }
  if (kind === "answer" && sources.length === 0)
    fail(`${path}.sources`, "an answer case needs at least one source")
  if (kind === "no_match" && sources.length > 0)
    fail(`${path}.sources`, "a no_match case has no source")
  const placeholders = strings(raw["placeholders"], `${path}.placeholders`)
  for (const placeholder of placeholders) {
    if (!(PLACEHOLDERS as readonly string[]).includes(placeholder))
      fail(`${path}.placeholders`, `${placeholder} is not a placeholder`)
  }
  return {
    id: str(raw["id"], `${path}.id`),
    question: str(raw["question"], `${path}.question`),
    kind,
    wants,
    counts: {
      matched: count(counts["matched"], `${path}.counts.matched`),
      searched: count(counts["searched"], `${path}.counts.searched`),
      readInFull: count(counts["readInFull"], `${path}.counts.readInFull`),
    },
    messages,
    sources,
    placeholders,
  }
}

export function parseAskCases(raw: unknown, source: string): AskEvalCase[] {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw["cases"]) ||
    raw["cases"].length === 0
  )
    return fail(source, "expected { cases: [...] } with at least one case")
  const cases = raw["cases"].map((item: unknown, i) =>
    parseAskCase(item, `${source}.cases[${String(i)}]`)
  )
  const seen = new Set<string>()
  for (const testCase of cases) {
    if (seen.has(testCase.id)) fail(source, `duplicate case id ${testCase.id}`)
    seen.add(testCase.id)
  }
  return cases
}

export function loadAskCases(filePath: string): AskEvalCase[] {
  return parseAskCases(JSON.parse(readFileSync(filePath, "utf8")), filePath)
}

/**
 * The answer request as `ask()` builds it: ANSWER_SYSTEM, then one user turn of facts, the
 * fenced messages and the question, and ANSWER_REMINDER after the question when `reminder` is on.
 */
export function buildAskRequest(
  testCase: AskEvalCase,
  reminder: boolean
): InferenceRequest {
  const { matched, searched, readInFull } = testCase.counts
  const facts = [
    "Facts (computed by code):",
    `matched: ${String(matched)}`,
    `searched: ${String(searched)}`,
    `readInFull: ${String(readInFull)}`,
    "readPartially: 0",
    `wants: ${testCase.wants}`,
  ].join("\n")
  const question = `\n\nQuestion: ${testCase.question}`
  return {
    system: ANSWER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `${facts}\n\nMessages:\n`,
          COMPACTION_LEGEND,
          ...testCase.messages.flatMap((message) =>
            blockParts({
              tag: message.tag,
              label: message.label,
              block: fence(
                toMaterial(message.body, {
                  source: message.label === "document" ? "document" : "mail",
                  ref: message.tag,
                })
              ),
            })
          ),
          reminder ? `${question}\n\n${ANSWER_REMINDER}` : question,
        ],
      },
    ],
    temperature: 0,
  }
}

const WELL_FORMED_TAG = /\[M\d+\]/g
const WORDED_TAG = /\[(?:message|msg|mail|doc|document)\s*\d+\]/i
// A number written before a word for messages: "3 messages", "1,284 matching messages".
const WRITTEN_COUNT =
  /\b\d[\d,]*\s+(?:(?:matching|relevant|indexed|total)\s+)?(?:messages?|emails?|mails?|matches|results?)\b/i

/** The tags the answer cites, without brackets, and whether any tag is written in a wrong form. */
export function readTags(answer: string): {
  cited: string[]
  malformed: boolean
} {
  const cited = [...answer.matchAll(WELL_FORMED_TAG)].map((m) =>
    m[0].slice(1, -1)
  )
  const rest = answer.replace(WELL_FORMED_TAG, "")
  return { cited, malformed: /\bM\d+\b/.test(rest) || WORDED_TAG.test(rest) }
}

export function scoreAnswer(
  testCase: AskEvalCase,
  answer: string
): AskCaseScore {
  const real = new Set(testCase.messages.map((m) => m.tag.slice(1, -1)))
  const { cited, malformed } = readTags(answer)
  const wanted = testCase.sources.map((s) => s.slice(1, -1))
  const tagCitation =
    !malformed &&
    cited.every((tag) => real.has(tag)) &&
    (testCase.kind === "no_match" || wanted.some((tag) => cited.includes(tag)))
  const placeholderUse =
    testCase.placeholders.every((p) => answer.includes(p)) &&
    !WRITTEN_COUNT.test(answer)
  const noMatchPhrasing =
    testCase.kind === "no_match"
      ? /no match found/i.test(answer) && !claimsAbsence(answer)
      : null
  return {
    id: testCase.id,
    tagCitation,
    placeholderUse,
    noMatchPhrasing,
    answer,
  }
}

function share(passed: number, total: number): number {
  return total === 0 ? 0 : passed / total
}

export function aggregate(scores: readonly AskCaseScore[]): AskScores {
  const noMatch = scores.filter((s) => s.noMatchPhrasing !== null)
  return {
    tagCitation: share(
      scores.filter((s) => s.tagCitation).length,
      scores.length
    ),
    placeholderUse: share(
      scores.filter((s) => s.placeholderUse).length,
      scores.length
    ),
    noMatchPhrasing: share(
      noMatch.filter((s) => s.noMatchPhrasing === true).length,
      noMatch.length
    ),
  }
}

/** Runs every case once per variant against the model, in order, and scores the replies. */
export async function runAskEval(options: {
  cases: readonly AskEvalCase[]
  client: ModelClient
  variant: AskVariant
  seed?: number
}): Promise<AskEvalReport> {
  const scored: AskCaseScore[] = []
  for (const testCase of options.cases) {
    const request = buildAskRequest(
      testCase,
      options.variant === "with-reminder"
    )
    const reply = await options.client.complete(
      options.seed === undefined ? request : { ...request, seed: options.seed }
    )
    scored.push(scoreAnswer(testCase, reply.text))
  }
  return {
    variant: options.variant,
    scores: aggregate(scored),
    cases: scored,
  }
}
