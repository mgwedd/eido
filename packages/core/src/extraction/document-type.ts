import {
  DOCUMENT_TYPE_CLASSIFICATION_JSON_SCHEMA,
  DOCUMENT_TYPE_CLASSIFICATION_PROMPT,
  validateDocumentTypeClassification,
} from "@eido/schemas"
import type { DocumentTypeLabel } from "@eido/schemas"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"
import { PromptTooLargeError } from "../inference/errors"
import {
  ESTIMATE_BOUNDARY,
  MATERIAL_RULES,
  fence,
  plainContent,
  toMaterial,
} from "../inference/fence"
import type { ChatMessage, ModelClient } from "../inference/types"

export const DOCUMENT_TYPE_REPLY_TOKENS = 128
const DOCUMENT_TYPE_MAX_CHARS = 6_000

const SYSTEM_PROMPT = [
  DOCUMENT_TYPE_CLASSIFICATION_PROMPT,
  MATERIAL_RULES,
].join("\n")

function classificationMessage(text: string): ChatMessage {
  let sampleEnd = Math.min(text.length, DOCUMENT_TYPE_MAX_CHARS)
  const finalCodeUnit = text.charCodeAt(sampleEnd - 1)
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) sampleEnd -= 1
  const sample = text.slice(0, sampleEnd)
  return {
    role: "user",
    content: [
      "Classify the stored document text below.",
      "Document text:\n",
      fence(toMaterial(sample, { source: "document" })),
    ],
  }
}

function requestCost(
  message: ChatMessage,
  charsPerToken: number,
  maxReplyTokens: number
): number {
  return (
    estimateTokens(
      SYSTEM_PROMPT + plainContent(message.content, ESTIMATE_BOUNDARY),
      charsPerToken
    ) + maxReplyTokens
  )
}

export type DocumentTypeClassification = {
  type: DocumentTypeLabel | null
  tokensUsed: number
}

/** Classifies a bounded, fenced sample. Invalid, truncated or unclear output produces no label. */
export async function classifyDocumentType(
  model: ModelClient,
  text: string,
  options: {
    tokenBudget: number
    charsPerToken?: number
    maxReplyTokens?: number
    signal?: AbortSignal
  }
): Promise<DocumentTypeClassification> {
  if (text.length === 0) return { type: null, tokensUsed: 0 }
  const maxReplyTokens = options.maxReplyTokens ?? DOCUMENT_TYPE_REPLY_TOKENS
  const message = classificationMessage(text)
  const cost = requestCost(
    message,
    options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
    maxReplyTokens
  )
  if (cost > options.tokenBudget) return { type: null, tokensUsed: 0 }

  try {
    const result = await model.complete(
      {
        system: SYSTEM_PROMPT,
        messages: [message],
        jsonSchema: { ...DOCUMENT_TYPE_CLASSIFICATION_JSON_SCHEMA },
        maxTokens: maxReplyTokens,
        temperature: -1,
      },
      { signal: options.signal }
    )
    if (result.truncationSuspected || result.finishReason === "length") {
      return { type: null, tokensUsed: cost }
    }
    let value: unknown
    try {
      value = JSON.parse(result.text)
    } catch {
      return { type: null, tokensUsed: cost }
    }
    const validated = validateDocumentTypeClassification(value)
    return {
      type: validated.ok ? validated.value.type : null,
      tokensUsed: cost,
    }
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (error instanceof PromptTooLargeError) {
      return { type: null, tokensUsed: cost }
    }
    // Classification is advisory; an unavailable model must not fail obligation extraction.
    return { type: null, tokensUsed: cost }
  }
}
