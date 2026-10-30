import type { DatabaseSync } from "node:sqlite"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"
import { PromptTooLargeError } from "../inference/errors"
import {
  ESTIMATE_BOUNDARY,
  INJECTION_REASONS,
  plainContent,
} from "../inference/fence"
import type { InjectionReason } from "../inference/fence"
import type { ChatMessage, ModelClient } from "../inference/types"
import { insertExtraction, insertObligation } from "../ledger/store"
import type { Parser } from "../parsers/parse-document"
import {
  DEFAULT_MAX_PASSAGES,
  DEFAULT_PHRASES,
  selectCandidatePassages,
} from "./prefilter"
import {
  EXTRACTION_SYSTEM_PROMPT,
  checkReply,
  correctionMessage,
  passageMessage,
  priorReply,
} from "./prompt"
import { normalizeParsed, passageReasons } from "./normalize"
import type { CandidateItem, ItemOutcome } from "./verify"
import { defaultFieldConfidence, verifyItem } from "./verify"
import { summarize } from "./summary"
import type {
  ConfirmCandidate,
  ExtractionLogEvent,
  ExtractionResult,
  ExtractionStatus,
  FieldScorer,
  Passage,
} from "./types"
import { extractionCandidatesJsonSchema } from "@eido/schemas"

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8
export const DEFAULT_TOKEN_BUDGET = 32_000
export const DEFAULT_EXTRACTION_REPLY_TOKENS = 1024
export const EXTRACTION_SCHEMA = "extracted-fields"

export type ExtractionConfig = {
  /** Recorded in `extractions.model`. */
  model: string
  /** A field scoring below this becomes a confirm candidate. Default 0.8. */
  threshold?: number
  phrases?: readonly string[]
  windowChars?: number
  maxPassages?: number
  /** Estimated tokens (prompts plus reply reservations) one document may use. Default 32,000. */
  tokenBudget?: number
  /** Reply reservation per call. Default 1,024. */
  maxReplyTokens?: number
  charsPerToken?: number
}

export type ExtractorDeps = {
  db: DatabaseSync
  /** Parses the stored original whose hash is the document's sha256. */
  parser: Pick<Parser, "parseDocument">
  model: ModelClient
  config: ExtractionConfig
  /** Per-field confidence. Default: 1.0 for a field that verified and parsed. */
  fieldConfidence?: FieldScorer
  log?: (event: ExtractionLogEvent) => void
  now?: () => Date
}

export type ExtractOptions = { signal?: AbortSignal }

export type ExtractionErrorCode = "document_not_found" | "parse_failed"

/** The document could not be read; nothing was written. Messages never hold document text. */
export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode

  constructor(code: ExtractionErrorCode, message: string) {
    super(message)
    this.name = "ExtractionError"
    this.code = code
  }
}

export type Extractor = {
  extractDocument(
    docSha256: string,
    opts?: ExtractOptions
  ): Promise<ExtractionResult>
}

type Proposed = {
  item: CandidateItem
  itemIndex: number
  replyText: string
  passage: Passage
  injectionReasons: InjectionReason[]
  tokenProbabilities?: readonly {
    bytes: readonly number[]
    probability: number
  }[]
}

function quoteProbability(
  reply: string,
  field: string,
  quote: string,
  itemIndex: number,
  probabilities: readonly { bytes: readonly number[]; probability: number }[]
): number | undefined {
  type JsonNode =
    | { kind: "string"; value: string; start: number; end: number }
    | { kind: "object"; properties: Map<string, JsonNode> }
    | { kind: "array"; items: JsonNode[] }
    | { kind: "other" }
  let cursor = 0
  const whitespace = (): void => {
    while (cursor < reply.length && /\s/u.test(reply.charAt(cursor)))
      cursor += 1
  }
  const stringNode = (): JsonNode => {
    const start = cursor
    if (reply.charAt(cursor) !== '"') throw new Error("JSON string expected")
    cursor += 1
    let closed = false
    while (cursor < reply.length) {
      const char = reply.charAt(cursor)
      cursor += 1
      if (char === "\\") cursor += 1
      else if (char === '"') {
        closed = true
        break
      }
    }
    if (!closed) throw new Error("JSON string is unterminated")
    const raw: unknown = JSON.parse(reply.slice(start, cursor))
    if (typeof raw !== "string") throw new Error("JSON string expected")
    return { kind: "string", value: raw, start, end: cursor }
  }
  const parseNode = (): JsonNode => {
    whitespace()
    const char = reply.charAt(cursor)
    if (char === '"') return stringNode()
    if (char === "{") {
      cursor += 1
      const properties = new Map<string, JsonNode>()
      whitespace()
      while (cursor < reply.length && reply.charAt(cursor) !== "}") {
        whitespace()
        const key = stringNode()
        if (key.kind !== "string") throw new Error("JSON object key expected")
        whitespace()
        if (reply.charAt(cursor) !== ":") throw new Error("JSON colon expected")
        cursor += 1
        properties.set(key.value, parseNode())
        whitespace()
        if (reply.charAt(cursor) !== ",") break
        cursor += 1
      }
      if (reply.charAt(cursor) !== "}") throw new Error("JSON object expected")
      cursor += 1
      return { kind: "object", properties }
    }
    if (char === "[") {
      cursor += 1
      const items: JsonNode[] = []
      whitespace()
      while (cursor < reply.length && reply.charAt(cursor) !== "]") {
        items.push(parseNode())
        whitespace()
        if (reply.charAt(cursor) !== ",") break
        cursor += 1
      }
      if (reply.charAt(cursor) !== "]") throw new Error("JSON array expected")
      cursor += 1
      return { kind: "array", items }
    }
    const start = cursor
    while (cursor < reply.length && !/[\s,}\]]/u.test(reply.charAt(cursor)))
      cursor += 1
    if (start === cursor) throw new Error("unexpected JSON character")
    return { kind: "other" }
  }
  let quoteStart: number | undefined
  let quoteEnd: number | undefined
  try {
    const root = parseNode()
    if (root.kind !== "object") return undefined
    const items = root.properties.get("items")
    if (items?.kind !== "array") return undefined
    const item = items.items[itemIndex]
    if (item === undefined || item.kind !== "object") return undefined
    const fieldNode = item.properties.get(field)
    if (fieldNode?.kind !== "object") return undefined
    const quoteNode = fieldNode.properties.get("quote")
    if (quoteNode?.kind !== "string" || quoteNode.value !== quote)
      return undefined
    quoteStart = quoteNode.start + 1
    quoteEnd = quoteNode.end - 1
  } catch {
    return undefined
  }
  if (quoteStart === undefined || quoteEnd === undefined) return undefined
  const encoder = new TextEncoder()
  const start = encoder.encode(reply.slice(0, quoteStart)).length
  const end = encoder.encode(reply.slice(0, quoteEnd)).length
  let offset = 0
  const scores: number[] = []
  for (const part of probabilities) {
    const next = offset + part.bytes.length
    if (offset < end && next > start) scores.push(part.probability)
    offset = next
  }
  if (scores.length === 0) return undefined
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

type AskOutcome =
  | {
      kind: "read"
      items: CandidateItem[]
      replyText: string
      tokenProbabilities?: readonly {
        bytes: readonly number[]
        probability: number
      }[]
    }
  | { kind: "skipped" }
  | { kind: "rejected" }

function savepoint<T>(db: DatabaseSync, work: () => T): T {
  db.exec("SAVEPOINT extraction_run")
  try {
    const result = work()
    db.exec("RELEASE extraction_run")
    return result
  } catch (error) {
    db.exec("ROLLBACK TO extraction_run")
    db.exec("RELEASE extraction_run")
    throw error
  }
}

/**
 * The extraction pipeline: the only consumer of raw untrusted text. For a document and schema,
 * it skips work once any extraction record exists, preserving the first run and preventing
 * retries or re-syncs from duplicating ledger rows. It has no tools and proposes no write; it
 * stores verified fields in the ledger and returns uncertain ones as confirm candidates.
 */
export function createExtractor(deps: ExtractorDeps): Extractor {
  const { db, parser, model, config } = deps
  const threshold = config.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD
  if (!(threshold >= 0 && threshold <= 1)) {
    throw new RangeError("threshold must be between 0 and 1")
  }
  const tokenBudget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  const maxReplyTokens =
    config.maxReplyTokens ?? DEFAULT_EXTRACTION_REPLY_TOKENS
  const charsPerToken = config.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const scorer = deps.fieldConfidence ?? defaultFieldConfidence
  const log = deps.log ?? (() => undefined)
  const now = deps.now ?? (() => new Date())
  const requestCost = (messages: ChatMessage[]): number =>
    estimateTokens(
      EXTRACTION_SYSTEM_PROMPT +
        messages
          .map((m) => plainContent(m.content, ESTIMATE_BOUNDARY))
          .join(""),
      charsPerToken
    ) + maxReplyTokens
  // What a passage costs beyond its own text: the system prompt, the wrapper and the reply.
  const overheadTokens = requestCost([
    { role: "user", content: passageMessage("") },
  ])

  function loadDocument(docId: string): { mime: string; entityId: string } {
    const row = db
      .prepare("SELECT mime, entity_id FROM documents WHERE sha256 = ?")
      .get(docId)
    if (row === undefined) {
      throw new ExtractionError("document_not_found", "no such document")
    }
    return { mime: String(row["mime"]), entityId: String(row["entity_id"]) }
  }

  async function extractDocument(
    docId: string,
    opts: ExtractOptions = {}
  ): Promise<ExtractionResult> {
    const doc = loadDocument(docId)
    if (
      db
        .prepare(
          "SELECT 1 FROM extractions WHERE doc_id = ? AND schema = ? LIMIT 1"
        )
        .get(docId, EXTRACTION_SCHEMA) !== undefined
    ) {
      const result = {
        docId,
        status: "already_processed" as const,
        proposed: 0,
        verified: 0,
        needsConfirmation: 0,
        dropped: 0,
        passagesRead: 0,
        passagesTotal: 0,
      }
      return {
        ...result,
        summary: summarize(result),
        confirmations: [],
        obligationIds: [],
        injectionReasons: [],
      }
    }
    const parsed = await parser.parseDocument({
      blobSha256: docId,
      mime: doc.mime,
    })
    if (!parsed.ok) {
      throw new ExtractionError(
        "parse_failed",
        `the document could not be parsed (${parsed.reason})`
      )
    }
    // Quotes are checked against the text exactly as the model read it.
    const normalized = normalizeParsed(parsed)
    const { passages, total } = selectCandidatePassages(
      normalized.text,
      normalized.offsets,
      {
        phrases: config.phrases ?? DEFAULT_PHRASES,
        windowChars: config.windowChars,
        maxPassages: config.maxPassages ?? DEFAULT_MAX_PASSAGES,
        tokenBudget,
        overheadTokens,
        charsPerToken,
      }
    )

    const createdAt = now().toISOString()
    // What fence found in the passages sent to the model, for the run's provenance.
    const sentReasons = new Set<InjectionReason>()
    const finish = (
      status: ExtractionStatus,
      counts: Pick<ExtractionResult, "passagesRead"> & Partial<ExtractionResult>
    ): ExtractionResult => {
      const result = {
        docId,
        status,
        proposed: counts.proposed ?? 0,
        verified: counts.verified ?? 0,
        needsConfirmation: counts.needsConfirmation ?? 0,
        dropped: counts.dropped ?? 0,
        passagesRead: counts.passagesRead,
        passagesTotal: total,
      }
      return {
        ...result,
        summary: summarize(result),
        confirmations: counts.confirmations ?? [],
        obligationIds: counts.obligationIds ?? [],
        injectionReasons: INJECTION_REASONS.filter((r) => sentReasons.has(r)),
      }
    }

    if (total === 0) {
      insertExtraction(db, {
        docId,
        schema: EXTRACTION_SCHEMA,
        status: "processed_empty",
        model: "none",
        createdAt,
      })
      return finish("no_candidates", { passagesRead: 0 })
    }

    let remaining = tokenBudget
    async function ask(passage: Passage, index: number): Promise<AskOutcome> {
      const messages: ChatMessage[] = [
        { role: "user", content: passageMessage(passage.text) },
      ]
      for (const attempt of [1, 2] as const) {
        // Refuse, never truncate: a request over the remaining budget, or over the model's
        // context (the client throws), is not sent. A first attempt skips the passage; a
        // retry that cannot be sent rejects it.
        const refuse = (): AskOutcome => {
          if (attempt === 1) {
            log({ event: "passage_skipped_over_budget", docId, passage: index })
            return { kind: "skipped" }
          }
          log({
            event: "reply_failed_check",
            docId,
            attempt,
            check: "over_budget",
          })
          return { kind: "rejected" }
        }
        const cost = requestCost(messages)
        if (cost > remaining) return refuse()
        let reply
        try {
          reply = await model.complete(
            {
              system: EXTRACTION_SYSTEM_PROMPT,
              messages,
              jsonSchema: { ...extractionCandidatesJsonSchema },
              maxTokens: maxReplyTokens,
              // llama.cpp reports greedy raw-softmax probabilities for temperatures below zero.
              temperature: -1,
              includeTokenProbabilities: true,
            },
            { signal: opts.signal }
          )
        } catch (error) {
          if (error instanceof PromptTooLargeError) return refuse()
          throw error
        }
        remaining -= cost
        const outcome = checkReply(reply)
        if (outcome.ok)
          return {
            kind: "read",
            items: outcome.candidates.items,
            replyText: reply.text,
            tokenProbabilities: reply.tokenProbabilities,
          }
        log({
          event: "reply_failed_check",
          docId,
          attempt,
          check: outcome.check,
        })
        messages.push(
          { role: "assistant", content: priorReply(reply.text) },
          {
            role: "user",
            content: correctionMessage(outcome.check, outcome.errors),
          }
        )
      }
      return { kind: "rejected" }
    }

    const proposedItems: Proposed[] = []
    let passagesRead = 0
    for (const [index, passage] of passages.entries()) {
      const outcome = await ask(passage, index)
      if (outcome.kind === "skipped") continue
      const injectionReasons = passageReasons(normalized, passage)
      for (const reason of injectionReasons) sentReasons.add(reason)
      if (outcome.kind === "rejected") {
        return finish("model_output_rejected", { passagesRead })
      }
      passagesRead += 1
      for (const [itemIndex, item] of outcome.items.entries()) {
        proposedItems.push({
          item,
          itemIndex,
          replyText: outcome.replyText,
          passage,
          injectionReasons,
          ...(outcome.tokenProbabilities === undefined
            ? {}
            : { tokenProbabilities: outcome.tokenProbabilities }),
        })
      }
    }
    if (passagesRead === 0) {
      return finish("refused_over_budget", { passagesRead })
    }

    const source = {
      text: normalized.text,
      offsets: normalized.originalOffsets,
      normalized,
    }
    const outcomes: { outcome: ItemOutcome; reasons: InjectionReason[] }[] =
      proposedItems.map(
        ({
          item,
          itemIndex,
          replyText,
          passage,
          injectionReasons,
          tokenProbabilities,
        }) => ({
          outcome: verifyItem(
            item,
            passage,
            source,
            threshold,
            deps.fieldConfidence ??
              (tokenProbabilities === undefined
                ? scorer
                : (input) =>
                    quoteProbability(
                      replyText,
                      input.field,
                      input.quote,
                      itemIndex,
                      tokenProbabilities
                    ) ?? scorer(input))
          ),
          reasons: injectionReasons,
        })
      )
    const confirmations: ConfirmCandidate[] = []
    const obligationIds: number[] = []
    let verified = 0
    let needsConfirmation = 0
    let dropped = 0
    savepoint(db, () => {
      for (const { outcome, reasons } of outcomes) {
        if (outcome.kind === "dropped") {
          dropped += 1
          continue
        }
        const extractionId = insertExtraction(db, {
          docId,
          schema: EXTRACTION_SCHEMA,
          status: "extracted",
          fields: outcome.fields,
          confidence: outcome.confidence,
          model: config.model,
          createdAt,
        })
        if (outcome.kind === "needs_confirmation") {
          needsConfirmation += 1
          for (const flag of outcome.flagged) {
            confirmations.push({
              docId,
              extractionId,
              threshold,
              ...flag,
              injectionSuspected: reasons.length > 0,
              injectionReasons: reasons,
            })
          }
          continue
        }
        verified += 1
        const { fields } = outcome
        obligationIds.push(
          insertObligation(db, {
            entityId: doc.entityId,
            ...(fields.party === undefined ? {} : { party: fields.party.raw }),
            action: fields.action.raw,
            ...(fields.due_date?.status === "parsed"
              ? { dueAt: fields.due_date.value }
              : {}),
            status: "open",
            docId,
            span: fields.action.span,
            injectionSuspected: reasons.length > 0,
            injectionReasons: reasons,
          })
        )
      }
      if (verified + needsConfirmation === 0) {
        insertExtraction(db, {
          docId,
          schema: EXTRACTION_SCHEMA,
          status: "processed_empty",
          model: config.model,
          createdAt,
        })
      }
    })
    return finish("ok", {
      proposed: outcomes.length,
      verified,
      needsConfirmation,
      dropped,
      passagesRead,
      confirmations,
      obligationIds,
    })
  }

  return { extractDocument }
}
