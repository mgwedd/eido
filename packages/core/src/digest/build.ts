import {
  ESTIMATE_BOUNDARY,
  MATERIAL_RULES,
  estimateTokens,
  fence,
  plainContent,
  toMaterial,
} from "../inference/index"
import type {
  InferenceQueue,
  InferenceResult,
  PromptPart,
} from "../inference/index"
import { planSections } from "./sections"
import { DigestBuildError } from "./types"
import type {
  Cite,
  DigestConfig,
  DigestCoverage,
  DigestLine,
  DigestSubject,
} from "./types"

/** Bumped whenever the prompts or the output handling change, which invalidates cached digests. */
export const DIGEST_PROMPT_VERSION = "digest-v2"

const SECTION_SYSTEM = [
  [
    "You summarize one section of a source into short factual lines.",
    'Each message or page is one material block with a ref attribute such as ref="m1" or ref="3"; a block with a part attribute is one piece of a longer message or page.',
    "Every line must cite the refs it comes from, using only refs that appear in the section.",
    "You see only part of the source, so never state that something was not discussed or did not happen.",
    'Reply as JSON: {"lines":[{"text":string,"cites":[string]}]}.',
  ].join(" "),
  MATERIAL_RULES,
].join("\n")

const MERGE_SYSTEM = [
  [
    "You merge summary lines of one source into a shorter list of lines.",
    "The lines come in one material block, each line ending with the bracketed refs it cites.",
    "Keep every distinct fact, combine duplicates, and cite only refs that appear in the input.",
    "Never state that something was not discussed or did not happen.",
    'Reply as JSON: {"lines":[{"text":string,"cites":[string]}]}.',
  ].join(" "),
  MATERIAL_RULES,
].join("\n")

/** The last line of every merge input, after the material. */
export const MERGE_TASK = "Merge the lines above."

/** A merge input: the earlier model output as one block, then the task line. */
function mergeContent(lines: readonly string[]): PromptPart[] {
  return [
    fence(toMaterial(lines.join("\n"), { source: "summary" })),
    `\n\n${MERGE_TASK}`,
  ]
}

const tokensOf = (content: readonly PromptPart[]): number =>
  estimateTokens(plainContent(content, ESTIMATE_BOUNDARY))

const LINES_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          cites: { type: "array", items: { type: "string" } },
        },
        required: ["text", "cites"],
      },
    },
  },
  required: ["lines"],
} as const

const MAX_MERGE_ROUNDS = 8

interface RefLine {
  text: string
  refs: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The lines of a model reply, checked against the real references of the source. */
function parseReply(
  result: InferenceResult,
  validRefs: ReadonlySet<string>
): { lines: RefLine[]; dropped: number } {
  if (result.finishReason === "length" || result.truncationSuspected) {
    throw new DigestBuildError("the model reply or prompt was cut short")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.text)
  } catch {
    throw new DigestBuildError("the model reply is not JSON")
  }
  const entries = isRecord(parsed) ? parsed["lines"] : undefined
  if (!Array.isArray(entries)) {
    throw new DigestBuildError("the model reply has no lines array")
  }
  const lines: RefLine[] = []
  let dropped = 0
  for (const entry of entries as unknown[]) {
    const text = isRecord(entry) ? entry["text"] : undefined
    const cites = isRecord(entry) ? entry["cites"] : undefined
    if (typeof text !== "string" || !Array.isArray(cites)) {
      throw new DigestBuildError("a model reply line has no text or cites")
    }
    const refs = [
      ...new Set(
        (cites as unknown[])
          .filter(
            (c): c is string | number =>
              typeof c === "string" || typeof c === "number"
          )
          .map(String)
          .filter((ref) => validRefs.has(ref))
      ),
    ]
    if (refs.length === 0 || text.trim() === "") dropped += 1
    else lines.push({ text: text.trim(), refs })
  }
  return { lines, dropped }
}

const renderLine = (line: RefLine): string =>
  `- ${line.text} [${line.refs.join(", ")}]`

function validRefsOf(subject: DigestSubject): Set<string> {
  return new Set(
    subject.kind === "thread"
      ? subject.messages.map((m) => m.id)
      : subject.pages.map((p) => String(p.page))
  )
}

function toCite(subject: DigestSubject, ref: string): Cite {
  return subject.kind === "thread"
    ? { messageId: ref }
    : { docSha256: subject.docSha256, page: Number(ref) }
}

/**
 * Summarizes every section in its own background job (one job per section, so the queue can run
 * foreground work between them), then merges the section summaries, in rounds when they do not
 * fit one input. Every model call goes through the queue. Nothing is stored here.
 */
export async function buildDigestLines(
  queue: InferenceQueue,
  subject: DigestSubject,
  config: DigestConfig
): Promise<{ lines: DigestLine[]; coverage: DigestCoverage }> {
  const validRefs = validRefsOf(subject)
  const plan = planSections(subject, config.sectionTokens)
  let dropped = 0

  const summarize = async (
    system: string,
    inputs: PromptPart[][]
  ): Promise<RefLine[][]> => {
    const done = await queue.runBatched(
      inputs,
      {
        tokensOf,
        maxBatchTokens: config.sectionTokens,
        maxBatchItems: 1,
      },
      async (batch, client) => {
        const result = await client.complete({
          system,
          messages: [{ role: "user", content: batch.flat() }],
          jsonSchema: LINES_SCHEMA,
          maxTokens: config.replyTokens,
          temperature: 0,
        })
        return parseReply(result, validRefs)
      }
    )
    if (done.oversize.length > 0) {
      throw new DigestBuildError("a model input exceeds the section budget")
    }
    return done.batches.map((b) => {
      dropped += b.output.dropped
      return b.output.lines
    })
  }

  let lines = (await summarize(SECTION_SYSTEM, plan.sections)).flat()

  if (plan.sections.length > 1) {
    for (let round = 0; ; round += 1) {
      if (round >= MAX_MERGE_ROUNDS) {
        throw new DigestBuildError(
          "merging the section summaries did not converge"
        )
      }
      // Group lines into inputs that fit the budget, then merge each group.
      const groups: PromptPart[][] = []
      let group: string[] = []
      for (const line of lines) {
        const rendered = renderLine(line)
        if (
          group.length > 0 &&
          tokensOf(mergeContent([...group, rendered])) > config.sectionTokens
        ) {
          groups.push(mergeContent(group))
          group = []
        }
        group.push(rendered)
      }
      if (group.length > 0) groups.push(mergeContent(group))
      lines = (await summarize(MERGE_SYSTEM, groups)).flat()
      if (groups.length <= 1) break
    }
  }

  const kept: DigestLine[] = lines.map((line) => ({
    text: line.text,
    cites: line.refs.map((ref) => toCite(subject, ref)),
  }))
  return {
    lines: kept,
    coverage: {
      sections: plan.sections.length,
      linesKept: kept.length,
      linesDropped: dropped,
      splitSegments: plan.splitSegments,
    },
  }
}
