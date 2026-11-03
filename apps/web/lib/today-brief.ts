import { validateCoreApiBrief, type CoreApiBrief } from "@eido/schemas"

export type BriefLine = CoreApiBrief["lines"][number]
export type BriefItemLine = Extract<
  BriefLine,
  { kind: "overdue" | "due" | "changed" | "needs-you" }
>
export type BriefMoreLine = Extract<BriefLine, { kind: "more" }>

export const BRIEF_URL = "/api/core/brief/latest"

export type RenderableBriefLine = BriefItemLine | BriefMoreLine

export function isItemLine(line: BriefLine): line is BriefItemLine {
  return line.kind !== "more" && line.kind !== "deferred"
}

/**
 * Filter out lines that lack a valid source link.
 * Acceptance criterion: A brief line without a source link is not rendered.
 * Deferred lines carry no source, so they are not rendered either.
 */
export function filterRenderableBriefLines(
  lines: readonly BriefLine[]
): RenderableBriefLine[] {
  return lines.filter((line): line is RenderableBriefLine => {
    if (line.kind === "more") return true
    if (!isItemLine(line)) return false
    return (
      Boolean(line.source) &&
      typeof line.source.documentId === "string" &&
      line.source.documentId.length === 64 &&
      Boolean(line.source.span) &&
      typeof line.source.span.start === "number" &&
      typeof line.source.span.end === "number"
    )
  })
}

/** Formats generation time, e.g. "7:02 AM". */
export function formatBriefTime(isoString: string): string {
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return ""
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(date)
  } catch {
    return ""
  }
}

/** Formats an earlier calendar date (YYYY-MM-DD), e.g. "Oct 17". */
export function formatBriefDate(dateString: string): string {
  const [yearStr, monthStr, dayStr] = dateString.split("-")
  const year = Number(yearStr)
  const month = Number(monthStr) - 1
  const day = Number(dayStr)
  if (isNaN(year) || isNaN(month) || isNaN(day)) return dateString

  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  return `${months[month]} ${day}`
}

/** Checks whether the brief is from an earlier calendar date than today. */
export function isBriefFromEarlierDay(briefDate: string, now: Date): boolean {
  const nowYear = now.getFullYear()
  const nowMonth = String(now.getMonth() + 1).padStart(2, "0")
  const nowDay = String(now.getDate()).padStart(2, "0")
  const todayStr = `${nowYear}-${nowMonth}-${nowDay}`
  return briefDate < todayStr
}

/** Formats the header info line: generation time or "Date · Time" if earlier. */
export function formatBriefHeaderMeta(
  brief: Pick<CoreApiBrief, "date" | "generatedAt">,
  now: Date
): string {
  const time = formatBriefTime(brief.generatedAt)
  if (isBriefFromEarlierDay(brief.date, now)) {
    const date = formatBriefDate(brief.date)
    return `${date} · ${time}`
  }
  return time
}

export type BriefState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unauthenticated" }
  | { status: "empty" }
  | {
      status: "ready"
      brief: CoreApiBrief
    }

export async function loadLatestBrief(
  signal: AbortSignal
): Promise<
  | { status: "ok"; brief: CoreApiBrief }
  | { status: "empty" }
  | { status: "unauthenticated" }
  | { status: "error" }
> {
  try {
    const response = await fetch(BRIEF_URL, { cache: "no-store", signal })
    if (response.status === 401) return { status: "unauthenticated" }
    if (response.status === 404) return { status: "empty" }
    if (!response.ok) return { status: "error" }
    const parsed = validateCoreApiBrief(await response.json())
    if (!parsed.ok) return { status: "error" }
    return { status: "ok", brief: parsed.value }
  } catch {
    return { status: "error" }
  }
}
