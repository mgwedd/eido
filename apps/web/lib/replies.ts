import type { Connector } from "@/lib/connectors"
import type { ObligationItem } from "@/lib/ledger"

export interface PartitionedReplies {
  owed: ObligationItem[]
  waiting: ObligationItem[]
}

/**
 * Extracts a display subject for a reply obligation.
 * Prefers the source document title if present, otherwise strips the prefix
 * from the stored action string, or falls back to the action itself.
 */
export function getReplySubject(row: ObligationItem): string {
  if (row.source?.title && row.source.title.trim()) {
    return row.source.title.trim()
  }

  if (row.direction === "waiting") {
    const match = /^Waiting on [^:]+:\s*(.*)$/.exec(row.action)
    if (match?.[1] && match[1].trim()) {
      return match[1].trim()
    }
  }

  if (row.direction === "owed") {
    const match = /^Reply to [^:]+:\s*(.*)$/.exec(row.action)
    if (match?.[1] && match[1].trim()) {
      return match[1].trim()
    }
  }

  return row.action
}

/**
 * Formats a Date object to YYYY-MM-DD in UTC (or local date) for comparison.
 */
function toDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/**
 * Sorts reply obligations: overdue first, then due date ascending (nulls last), then id ascending.
 */
export function sortReplies(
  items: readonly ObligationItem[],
  now: Date
): ObligationItem[] {
  const todayStr = toDateStr(now)

  return [...items].sort((a, b) => {
    const aOverdue = Boolean(a.dueAt && a.dueAt < todayStr)
    const bOverdue = Boolean(b.dueAt && b.dueAt < todayStr)

    if (aOverdue !== bOverdue) {
      return aOverdue ? -1 : 1
    }

    if (a.dueAt !== b.dueAt) {
      if (!a.dueAt) return 1
      if (!b.dueAt) return -1
      return a.dueAt.localeCompare(b.dueAt)
    }

    return a.id - b.id
  })
}

/**
 * Partitions reply obligations into owed (you must reply) and waiting (waiting on others).
 */
export function partitionReplies(
  items: readonly ObligationItem[]
): PartitionedReplies {
  const owed: ObligationItem[] = []
  const waiting: ObligationItem[] = []

  for (const item of items) {
    if (item.direction === "owed") {
      owed.push(item)
    } else if (item.direction === "waiting") {
      waiting.push(item)
    }
  }

  return { owed, waiting }
}

/**
 * Returns the URL for /ledger/replies with entity query parameter.
 */
export function getRepliesUrl(entity?: string): string {
  if (entity && entity !== "all") {
    return `/ledger/replies?entity=${encodeURIComponent(entity)}`
  }
  return "/ledger/replies"
}

export const DRAFT_REPLY_URL = "/api/ask"

export interface DraftReplyRequest {
  threadId: string
  url?: string
}

export interface DraftReplyResult {
  ok: boolean
  intentId?: string
  error?: string
}

/**
 * Asks Eido for a draft reply through the ask pipeline.
 * Creates an email draft intent (draft tier, never sent).
 */
export async function requestDraftReply(
  request: DraftReplyRequest,
  signal?: AbortSignal
): Promise<DraftReplyResult> {
  const url = request.url ?? DRAFT_REPLY_URL
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        threadId: request.threadId,
        thread_id: request.threadId,
      }),
      signal,
    })

    if (!response.ok) {
      return {
        ok: false,
        error: `Request failed with status ${response.status}`,
      }
    }

    const data = (await response.json()) as Record<string, unknown>
    const intentId =
      typeof data["intentId"] === "string"
        ? data["intentId"]
        : typeof data["id"] === "string"
          ? data["id"]
          : typeof (data["intent"] as Record<string, unknown> | undefined)?.[
                "id"
              ] === "string"
            ? String((data["intent"] as Record<string, unknown>)["id"])
            : undefined

    return { ok: true, intentId }
  } catch (err) {
    if (signal?.aborted) {
      return { ok: false, error: "Aborted" }
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
    }
  }
}

/**
 * Returns a partial coverage notice if a relevant mail connector is paused/unhealthy/disabled.
 */
export function getPartialCoverageNotice(
  connectors: readonly Connector[]
): string | null {
  for (const c of connectors) {
    if (c.name === "proton-mail" && (c.health !== "healthy" || !c.enabled)) {
      return "Proton Mail paused: its threads are not included."
    }
    if (c.name === "gmail" && (c.health !== "healthy" || !c.enabled)) {
      return "Gmail paused: its threads are not included."
    }
  }
  return null
}

