import {
  validateCoreApiAskRequest,
  validateCoreApiAskResponse,
  validateGateProposeResult,
  validateIntent,
} from "@eido/schemas"
import type { AskFigure, AskFollowUp, CoreApiAskResponse } from "@eido/schemas"

export type AskLoad =
  { status: "ready"; value: CoreApiAskResponse } | { status: "error" }

export async function loadAnswer(
  question: string,
  signal: AbortSignal
): Promise<AskLoad> {
  const request = validateCoreApiAskRequest({ question: question.trim() })
  if (!request.ok) return { status: "error" }
  try {
    const response = await fetch("/api/core/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(request.value),
      signal,
    })
    if (!response.ok) return { status: "error" }
    const checked = validateCoreApiAskResponse(await response.json())
    return checked.ok
      ? { status: "ready", value: checked.value }
      : { status: "error" }
  } catch {
    return { status: "error" }
  }
}

export type ProposalLoad =
  { status: "proposed"; href: "/queue" | "/activity" } | { status: "error" }

/** A selected candidate goes only to the core-to-gate proposal handoff, never an executor. */
export async function submitFollowUp(
  intent: unknown,
  signal: AbortSignal
): Promise<ProposalLoad> {
  const checked = validateIntent(intent)
  if (!checked.ok) return { status: "error" }
  try {
    const response = await fetch("/api/core/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ intent: checked.value, origin: "reactive" }),
      signal,
    })
    if (!response.ok) return { status: "error" }
    const result = validateGateProposeResult(await response.json())
    if (!result.ok || result.value.tier === "forbidden")
      return { status: "error" }
    return {
      status: "proposed",
      href: result.value.tier === "auto" ? "/activity" : "/queue",
    }
  } catch {
    return { status: "error" }
  }
}

export function answerParts(
  result: CoreApiAskResponse
): { text: string; tag?: string }[] {
  const known = new Set(result.citations.map((citation) => citation.tag))
  return result.answer
    .split(/(\[[A-Za-z]+\d+\])/g)
    .filter(Boolean)
    .map((text) => {
      const tag = text.slice(1, -1)
      return known.has(tag) && text.startsWith("[") ? { text, tag } : { text }
    })
}

/** Stable references identify computed values; prose and coincidental matching digits do not. */
export function computedFigures(result: CoreApiAskResponse): AskFigure[] {
  return result.figures.filter(
    (figure) =>
      figure.location === `/coverage/${figure.key}` &&
      figure.value === result.coverage[figure.key]
  )
}

export const FIGURE_LABELS: Record<AskFigure["key"], string> = {
  matched: "Matched",
  searched: "Searched",
  readInFull: "Read in full",
}

export function actionableFollowUps(result: CoreApiAskResponse): AskFollowUp[] {
  return result.status === "answered" ? result.followUps : []
}
