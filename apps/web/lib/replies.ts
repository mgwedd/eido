import {
  validateCoreApiError,
  validateCoreApiObligationState,
  validateCoreApiReplyDraftResponse,
  type CoreApiError,
  type CoreApiReplyDraftRequest,
} from "@eido/schemas"
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
 * The row id the `j` (next) or `k` (previous) key moves focus to. With nothing focused either key
 * lands on the first row; at either end focus stays put. No rows, no focus.
 */
export function moveRowFocus(
  ids: readonly number[],
  current: number | null,
  direction: "next" | "previous"
): number | null {
  const first = ids[0]
  if (first === undefined) return null
  const index = current === null ? -1 : ids.indexOf(current)
  if (index === -1) return first
  const target = direction === "next" ? index + 1 : index - 1
  return ids[Math.min(Math.max(target, 0), ids.length - 1)] ?? first
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

/** Core's draft-reply route, reached through the web's core proxy. */
export const DRAFT_REPLY_URL = "/api/core/replies/draft"

export type DraftReplyErrorCode = CoreApiError["error"]["code"]

/**
 * What the row shows for one draft request. `saved` comes only from a 200 or 201 whose body is a
 * CoreApiReplyDraftResponse; every other answer is `failed` and the row stays retryable.
 */
export type DraftReplyOutcome =
  | { status: "saved"; activityHref: string; created: boolean }
  | {
      status: "failed"
      reason: DraftReplyErrorCode | "unauthenticated" | "network" | "unreadable"
    }

/** One row's draft state in the view. A row with no entry is idle. */
export type DraftReplyState =
  | { status: "pending" }
  | { status: "saved"; activityHref: string }
  | { status: "failed"; reason: DraftReplyFailure }

export type DraftReplyFailure = Extract<
  DraftReplyOutcome,
  { status: "failed" }
>["reason"]

/** Where "Draft saved" leads when the list says a draft exists but not which one. */
export const ACTIVITY_URL = "/activity"

/** Where a paused connector is resumed. */
export const CONNECTORS_URL = "/connectors"

/**
 * Asks core to draft a reply for an owed-reply obligation. Core proposes one `email.draft`
 * intent (draft tier, never sent, no approval) and answers 201, or 200 with the existing one when
 * the thread already has a live draft.
 */
export async function requestDraftReply(
  obligationId: number
): Promise<DraftReplyOutcome> {
  let response: Response
  try {
    response = await fetch(DRAFT_REPLY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ obligationId } satisfies CoreApiReplyDraftRequest),
    })
  } catch {
    return { status: "failed", reason: "network" }
  }

  if (response.status === 401) {
    return { status: "failed", reason: "unauthenticated" }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: "failed", reason: "unreadable" }
  }

  if (response.status === 200 || response.status === 201) {
    const parsed = validateCoreApiReplyDraftResponse(body)
    if (!parsed.ok) return { status: "failed", reason: "unreadable" }
    return {
      status: "saved",
      activityHref: parsed.value.activityHref,
      created: parsed.value.created,
    }
  }

  const error = validateCoreApiError(body)
  if (!error.ok) return { status: "failed", reason: "unreadable" }
  return { status: "failed", reason: error.value.error.code }
}

/** The row's message for a failed draft. Core's own message is not shown: it is for logs. */
export function draftFailureMessage(reason: DraftReplyFailure): string {
  switch (reason) {
    case "connector_paused":
      return "Mail connector paused. Nothing was drafted."
    case "no_draft":
      return "Eido could not write a draft for this thread. Try again."
    case "busy":
      return "Too many drafts this hour. Try again later."
    case "gate_unavailable":
      return "Gate unreachable. Nothing was saved. Try again."
    case "invalid_transition":
      return "This reply is no longer open. Reload the page."
    case "invalid":
      return "This thread cannot be drafted from here."
    case "not_found":
      return "Cannot draft this reply: it may be gone, or no local model is set up."
    case "unauthenticated":
      return "Sign in again to draft a reply."
    case "network":
      return "Connection lost. Nothing was saved. Try again."
    default:
      return "Draft failed. Nothing was saved. Try again."
  }
}

/** Core's local resolve route for one obligation, reached through the web's core proxy. */
export function resolveObligationUrl(obligationId: number): string {
  return `/api/core/obligations/${obligationId}/resolve`
}

export type ResolveFailure =
  CoreApiError["error"]["code"] | "unauthenticated" | "network" | "unreadable"

/** What one resolve request came to. `resolved` only for a 200 that says this obligation is done. */
export type ResolveOutcome =
  { status: "resolved" } | { status: "failed"; reason: ResolveFailure }

/** One Waiting on row's resolve state in the view. A row with no entry is idle. */
export type ResolveState =
  { status: "pending" } | { status: "failed"; reason: ResolveFailure }

/**
 * Marks an obligation resolved in core. It is a local state change, never an external write: the
 * obligation moves from open to done and the row leaves the list.
 */
export async function requestResolveObligation(
  obligationId: number
): Promise<ResolveOutcome> {
  let response: Response
  try {
    response = await fetch(resolveObligationUrl(obligationId), {
      method: "POST",
      cache: "no-store",
    })
  } catch {
    return { status: "failed", reason: "network" }
  }

  if (response.status === 401) {
    return { status: "failed", reason: "unauthenticated" }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: "failed", reason: "unreadable" }
  }

  if (response.status === 200) {
    const state = validateCoreApiObligationState(body)
    if (
      !state.ok ||
      state.value.id !== obligationId ||
      state.value.status !== "done"
    ) {
      return { status: "failed", reason: "unreadable" }
    }
    return { status: "resolved" }
  }

  const error = validateCoreApiError(body)
  if (!error.ok) return { status: "failed", reason: "unreadable" }
  return { status: "failed", reason: error.value.error.code }
}

/** The row's message for a failed resolve. Core's own message is not shown: it is for logs. */
export function resolveFailureMessage(reason: ResolveFailure): string {
  switch (reason) {
    case "not_found":
      return "This thread is gone. Reload the page."
    case "invalid_transition":
      return "This thread is no longer open. Reload the page."
    case "unauthenticated":
      return "Sign in again to mark this resolved."
    case "network":
      return "Connection lost. Nothing was changed. Try again."
    default:
      return "Could not mark this resolved. Nothing was changed. Try again."
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
