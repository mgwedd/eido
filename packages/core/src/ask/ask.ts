import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { countMatches, search } from "../index/search"
import { LIVE_DOCUMENT_PREDICATE } from "../index/heads"
import type { SearchQuery } from "../index/search"
import { packParts } from "../context/pack-store"
import type { PackMember } from "../context/pack-store"
import { PromptTooLargeError } from "../inference/errors"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"
import {
  ESTIMATE_BOUNDARY,
  MATERIAL_RULES,
  fence,
  plainContent,
  toMaterial,
} from "../inference/fence"
import type { PromptPart } from "../inference/fence"
import type { ModelClient } from "../inference/types"
import {
  absenceReplacement,
  checkTags,
  claimsAbsence,
  coverageLabel,
  noMatchAnswer,
  substitutePlaceholders,
} from "./answer"
import { buildAskPack } from "./pack"
import { PLAN_SCHEMA, PLAN_SYSTEM, parsePlan } from "./plan"
import type { AskCitation, AskDeps, AskResult, SearchPlan } from "./types"

const DEFAULT_SEARCH_LIMIT = 20

/** Stable across requests, so the server's prompt cache keeps it. */
export const ANSWER_SYSTEM = [
  "You answer the owner's question from the messages below, and from nothing else.",
  "Each message has a tag line such as [M1] before its material block. Cite the messages you use by their tag, for example [M2].",
  "Never write a count of messages. Write {matches} for the number of matching messages, {read} for the number you can read, and {searched} for the number searched.",
  'If the messages do not answer the question, say "no match found". Never say that something did not happen or does not exist.',
  MATERIAL_RULES,
].join("\n")

function refused(
  reason: string,
  matched: number,
  searched: number,
  matchCount: number | null,
  possiblyTruncated: boolean
): AskResult {
  return {
    status: "refused",
    answer: "",
    citations: [],
    coverage: {
      searched,
      matched,
      readInFull: 0,
      label: coverageLabel(0, matched),
    },
    facts: { matchCount },
    droppedTags: [],
    possiblyTruncated,
    reason,
  }
}

/** Indexed documents inside the plan's date filters, whatever their text. */
export function countSearched(db: DatabaseSync, plan: SearchPlan): number {
  const conditions: string[] = []
  const params: SQLInputValue[] = []
  if (plan.after !== undefined) {
    conditions.push("t.occurred_at >= ?")
    params.push(plan.after)
  }
  if (plan.before !== undefined) {
    conditions.push("t.occurred_at < ?")
    params.push(plan.before)
  }
  const where =
    conditions.length === 0 ? "" : ` AND ${conditions.join(" AND ")}`
  return Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM document_text t
         JOIN documents d ON d.sha256 = t.sha256
         WHERE ${LIVE_DOCUMENT_PREDICATE}${where}`
      )
      .get(...params)?.["n"] ?? 0
  )
}

function citationFor(
  db: DatabaseSync,
  tag: string,
  member: PackMember
): AskCitation {
  const documentId = member.sha256
  const row = db
    .prepare(
      `SELECT d.source, d.source_ref, t.title, t.occurred_at FROM documents d
       JOIN document_text t ON t.sha256 = d.sha256
       WHERE ${LIVE_DOCUMENT_PREDICATE} AND d.sha256 = ?`
    )
    .get(documentId)
  // Every pack member was read from the index, so its row is there.
  if (row === undefined)
    throw new Error("a cited pack member is not in the index")
  const title = row["title"]
  const occurredAt = row["occurred_at"]
  return {
    tag,
    documentId,
    source: String(row["source"]),
    sourceRef: String(row["source_ref"]),
    ...(typeof title === "string" && title !== "" ? { title } : {}),
    ...(typeof occurredAt === "string" && occurredAt !== ""
      ? { occurredAt }
      : {}),
    injectionSuspected: member.injectionSuspected,
    injectionReasons: member.injectionReasons,
  }
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10)

function factsText(
  plan: SearchPlan,
  matched: number,
  searched: number,
  readInFull: number
): string {
  return [
    "Facts (computed by code):",
    `matched: ${String(matched)}`,
    `searched: ${String(searched)}`,
    `readInFull: ${String(readInFull)}`,
    `wants: ${plan.wants}`,
  ].join("\n")
}

function conversationParts(turns: AskDeps["conversation"]): PromptPart[] {
  if (turns === undefined || turns.length === 0) return []
  return [
    "Conversation so far (prior turns may help interpret the question):\n",
    ...turns.flatMap((turn) =>
      turn.role === "user"
        ? [`[user ${turn.at}] ${turn.text}\n`]
        : [
            `[${turn.role} ${turn.at}]\n`,
            fence(
              toMaterial(turn.text, {
                source: turn.role === "summary" ? "summary" : "assistant",
              })
            ),
            "\n",
          ]
    ),
    "\n",
  ]
}

async function run(
  question: string,
  deps: AskDeps,
  client: ModelClient
): Promise<AskResult> {
  const { db } = deps
  const today = isoDate((deps.now ?? (() => new Date()))())

  // Step 1: the model writes a search plan; code runs it.
  let planned
  try {
    planned = await client.complete({
      system: PLAN_SYSTEM,
      messages: [
        { role: "user", content: `Today is ${today}.\nQuestion: ${question}` },
      ],
      jsonSchema: PLAN_SCHEMA,
      temperature: 0,
    })
  } catch (error) {
    if (error instanceof PromptTooLargeError)
      return refused(
        "the question does not fit the model's context",
        0,
        0,
        null,
        false
      )
    throw error
  }
  const truncatedPlan = planned.truncationSuspected
  const plan = parsePlan(planned.text)
  if (plan === null)
    return refused(
      "the model did not return a usable search plan",
      0,
      0,
      null,
      truncatedPlan
    )

  const query: SearchQuery = {
    text: plan.terms.join(" "),
    ...(plan.after === undefined ? {} : { after: plan.after }),
    ...(plan.before === undefined ? {} : { before: plan.before }),
  }
  const searched = countSearched(db, plan)
  const matchCount = countMatches(db, query)

  if (matchCount === 0) {
    return {
      status: "no_match",
      answer: noMatchAnswer(plan.terms, searched),
      citations: [],
      coverage: {
        searched,
        matched: 0,
        readInFull: 0,
        label: coverageLabel(0, 0),
      },
      facts: { matchCount },
      droppedTags: [],
      possiblyTruncated: truncatedPlan,
    }
  }

  const hits = search(db, {
    ...query,
    limit: deps.searchLimit ?? DEFAULT_SEARCH_LIMIT,
  })
  const historyParts = conversationParts(deps.conversation)
  const contextHeaderParts: PromptPart[] = [
    `${factsText(
      plan,
      matchCount,
      searched,
      Number.MAX_SAFE_INTEGER
    )}\n\nMessages:\n`,
    `\n\nQuestion: ${question}`,
  ]
  const charsPerToken = deps.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const fixedContextTokens = estimateTokens(
    plainContent([...historyParts, ...contextHeaderParts], ESTIMATE_BOUNDARY),
    charsPerToken
  )
  const packBudgetTokens = deps.budgetTokens - fixedContextTokens
  if (packBudgetTokens <= 0) {
    return refused(
      `the conversation and question need ${String(fixedContextTokens)} tokens, over the ${String(deps.budgetTokens)} ask budget`,
      matchCount,
      searched,
      matchCount,
      truncatedPlan
    )
  }
  const pack = await buildAskPack(db, {
    hits: hits.map((h) => h.sha256),
    budgetTokens: packBudgetTokens,
    ...(deps.charsPerToken === undefined
      ? {}
      : { charsPerToken: deps.charsPerToken }),
  })
  if ("refused" in pack) {
    return refused(
      `the top matching message needs ${String(pack.seedTokens)} tokens; the conversation and question leave ${String(pack.budgetTokens)} of ${String(deps.budgetTokens)} ask tokens for messages`,
      matchCount,
      searched,
      matchCount,
      truncatedPlan
    )
  }

  const readInFull = pack.members.length
  const facts = factsText(plan, matchCount, searched, readInFull)

  // Step 2: the model answers from the pack.
  let answered
  try {
    answered = await client.complete({
      system: ANSWER_SYSTEM,
      messages: [
        {
          role: "user",
          // The material first; the owner's question last, unfenced.
          content: [
            ...historyParts,
            `${facts}\n\nMessages:\n`,
            ...packParts(pack),
            `\n\nQuestion: ${question}`,
          ],
        },
      ],
      temperature: 0,
    })
  } catch (error) {
    if (error instanceof PromptTooLargeError)
      return refused(
        "the messages and the question do not fit the model's context",
        matchCount,
        searched,
        matchCount,
        truncatedPlan
      )
    throw error
  }
  const possiblyTruncated = truncatedPlan || answered.truncationSuspected
  const coverage = {
    searched,
    matched: matchCount,
    readInFull,
    label: coverageLabel(readInFull, matchCount),
  }

  const withCounts = substitutePlaceholders(answered.text, {
    matches: matchCount,
    read: readInFull,
    searched,
  })
  const byTag = new Map(pack.members.map((m) => [m.tag.slice(1, -1), m]))
  const checked = checkTags(withCounts, new Set(byTag.keys()))
  if (claimsAbsence(checked.text)) {
    return {
      status: "answered",
      answer: absenceReplacement(readInFull),
      citations: [],
      coverage,
      facts: { matchCount },
      droppedTags: checked.dropped,
      possiblyTruncated,
    }
  }
  const citations = checked.cited.flatMap((tag) => {
    const member = byTag.get(tag)
    if (member === undefined) return []
    const citation = citationFor(db, tag, member)
    return [
      deps.allocateSourceTag === undefined
        ? citation
        : { ...citation, tag: deps.allocateSourceTag(citation.sourceRef) },
    ]
  })
  let answer = checked.text
  if (deps.allocateSourceTag !== undefined) {
    for (const citation of citations) {
      const original = checked.cited.find((tag) => {
        const member = byTag.get(tag)
        return (
          member !== undefined &&
          citationFor(db, tag, member).sourceRef === citation.sourceRef
        )
      })
      if (original !== undefined)
        answer = answer.replaceAll(`[${original}]`, `[${citation.tag}]`)
    }
  }
  return {
    status: "answered",
    answer,
    // `checkTags` keeps only tags in the pack, so every cited tag has a member.
    citations,
    coverage,
    facts: { matchCount },
    droppedTags: checked.dropped,
    possiblyTruncated,
  }
}

/**
 * Answer a question from the index. Two model steps: a search plan under a JSON schema, then an
 * answer from a context pack. Code computes every count, checks every citation tag against the
 * pack and builds the coverage label. It only reads: it creates no intents. The whole ask is one
 * foreground job, so background work waits behind it and it waits at most for one running job.
 */
export function ask(question: string, deps: AskDeps): Promise<AskResult> {
  return deps.queue.run("foreground", (client) => run(question, deps, client))
}
