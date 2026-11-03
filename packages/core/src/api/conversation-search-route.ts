import type { CoreApiConversationSearch, CoreApiError } from "@eido/schemas"
import { validateCoreApiConversationSearch } from "@eido/schemas"
import type { ConversationStore } from "../conversation/store"
import type { SearchKind } from "../conversation/types"

export const CONVERSATION_SEARCH_PATH = "/conversations/search"
export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 100
export const MAX_QUERY_LENGTH = 256

type FieldError = { field: string; message: string }

export type ConversationSearchResult =
  | { ok: true; body: CoreApiConversationSearch }
  | {
      ok: false
      code: CoreApiError["error"]["code"]
      message: string
      fields?: FieldError[]
    }

const DIGITS = /^\d+$/

function param(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim()
  return value === undefined || value === "" ? undefined : value
}

function readCount(
  params: URLSearchParams,
  name: string,
  min: number,
  max: number,
  fallback: number,
  errors: FieldError[]
): number {
  const raw = param(params, name)
  if (raw === undefined) return fallback
  const value = DIGITS.test(raw) ? Number(raw) : NaN
  if (!(value >= min && value <= max)) {
    errors.push({
      field: name,
      message: `must be an integer from ${min} to ${max}`,
    })
  }
  return value
}

export function conversationSearchRoute(
  conversations: ConversationStore,
  params: URLSearchParams
): ConversationSearchResult {
  const errors: FieldError[] = []
  const limit = readCount(
    params,
    "limit",
    1,
    MAX_SEARCH_LIMIT,
    DEFAULT_SEARCH_LIMIT,
    errors
  )

  const rawKind = param(params, "kind")
  let kind: SearchKind | "any" = "any"
  if (rawKind !== undefined) {
    if (rawKind === "raw" || rawKind === "digest" || rawKind === "any") {
      kind = rawKind
    } else {
      errors.push({
        field: "kind",
        message: 'must be "raw", "digest" or "any"',
      })
    }
  }

  const q = params.get("q")?.trim() ?? ""
  if (q.length > MAX_QUERY_LENGTH) {
    errors.push({
      field: "q",
      message: `must be at most ${String(MAX_QUERY_LENGTH)} characters`,
    })
  }

  if (errors.length > 0) {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: errors,
    }
  }

  if (q === "") {
    return {
      ok: true,
      body: { hits: [] },
    }
  }

  const rawHits = conversations.searchConversations(q, { limit, kind })
  const hits = rawHits.map((hit) => ({
    conversationId: hit.conversationId,
    ...(hit.turnId !== undefined ? { turnId: hit.turnId } : {}),
    kind: hit.kind,
    snippet: hit.snippet,
    score: hit.score,
  }))

  const validation = validateCoreApiConversationSearch({ hits })
  if (!validation.ok) {
    return {
      ok: false,
      code: "internal",
      message: "invalid conversation search response",
    }
  }

  return {
    ok: true,
    body: validation.value,
  }
}
