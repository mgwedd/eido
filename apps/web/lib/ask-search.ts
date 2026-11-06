import {
  validateCoreApiConversationGet,
  validateCoreApiConversationSearch,
} from "@eido/schemas"
import type {
  CoreApiConversationGet,
  CoreApiConversationSearch,
} from "@eido/schemas"

export type SearchHit = CoreApiConversationSearch["hits"][number]

/** The Show filter on the board: All, Turns and Digests map to the core `kind` values. */
export type KindFilter = "any" | "raw" | "digest"
export const KIND_FILTERS: readonly { value: KindFilter; label: string }[] = [
  { value: "any", label: "All" },
  { value: "raw", label: "Turns" },
  { value: "digest", label: "Digests" },
]

export const SEARCH_DEBOUNCE_MS = 250
export const MIN_QUERY_LENGTH = 2
export const MAX_QUERY_LENGTH = 256
export const SEARCH_LIMIT = 20

/** Core wraps each match in these private-use characters, which never occur in turn text. */
const MATCH_START = ""
const MATCH_END = ""

export type SnippetPart = { text: string; match: boolean }

/**
 * Splits a snippet on the match markers. Text only: the parts are rendered as React text,
 * so a snippet that quotes markup stays inert. A marker never reaches the output.
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let current = ""
  let inMatch = false
  const flush = () => {
    if (current !== "") parts.push({ text: current, match: inMatch })
    current = ""
  }
  for (const char of snippet) {
    if (char === MATCH_START) {
      flush()
      inMatch = true
    } else if (char === MATCH_END) {
      flush()
      inMatch = false
    } else {
      current += char
    }
  }
  flush()
  return parts
}

export function isSearchable(query: string): boolean {
  return query.trim().length >= MIN_QUERY_LENGTH
}

export function matchCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "match" : "matches"}`
}

/** Where the Ask page is: the question box, or search with an optional open conversation. */
export type AskRoute = {
  search: string | null
  conversation: string | null
  turn: string | null
}
export const ASK_ROUTE: AskRoute = {
  search: null,
  conversation: null,
  turn: null,
}

export function isSearchRoute(route: AskRoute): boolean {
  return route.search !== null || route.conversation !== null
}

export function parseRoute(queryString: string): AskRoute {
  const params = new URLSearchParams(queryString)
  const conversation = params.get("conversation")
  return {
    search: params.get("search"),
    conversation: conversation === "" ? null : conversation,
    turn:
      conversation === null || conversation === "" ? null : params.get("turn"),
  }
}

export function routeUrl(route: AskRoute): string {
  const params = new URLSearchParams()
  if (route.search !== null) params.set("search", route.search)
  if (route.conversation) {
    params.set("conversation", route.conversation)
    if (route.turn) params.set("turn", route.turn)
  }
  const query = params.toString()
  return query === "" ? "/ask" : `/ask?${query}`
}

export type SearchLoad =
  { status: "ready"; hits: SearchHit[] } | { status: "error" }

export async function loadSearch(
  query: string,
  kind: KindFilter,
  signal: AbortSignal
): Promise<SearchLoad> {
  const params = new URLSearchParams({
    q: query.trim(),
    limit: String(SEARCH_LIMIT),
    kind,
  })
  try {
    const response = await fetch(
      `/api/core/conversations/search?${params.toString()}`,
      { cache: "no-store", signal }
    )
    if (!response.ok) return { status: "error" }
    const checked = validateCoreApiConversationSearch(await response.json())
    return checked.ok
      ? { status: "ready", hits: checked.value.hits }
      : { status: "error" }
  } catch {
    return { status: "error" }
  }
}

export type ConversationLoad =
  | { status: "ready"; value: CoreApiConversationGet }
  | { status: "gone" }
  | { status: "error" }

export async function loadConversation(
  id: string,
  signal: AbortSignal
): Promise<ConversationLoad> {
  try {
    const response = await fetch(
      `/api/core/conversations/${encodeURIComponent(id)}`,
      { cache: "no-store", signal }
    )
    if (response.status === 404) return { status: "gone" }
    if (!response.ok) return { status: "error" }
    const checked = validateCoreApiConversationGet(await response.json())
    return checked.ok
      ? { status: "ready", value: checked.value }
      : { status: "error" }
  } catch {
    return { status: "error" }
  }
}

/** The viewer header date: the first turn's date. */
export function conversationDate(
  conversation: CoreApiConversationGet
): string | undefined {
  const first = conversation.turns[0]
  if (first === undefined) return undefined
  const date = new Date(first.at)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}

export function turnCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "turn" : "turns"} · read only`
}
