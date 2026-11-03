import {
  validateCoreApiEntityList,
  validateCoreApiTodayDueSoon,
  type CoreApiEntityList,
  type CoreApiTodayDueSoon,
  type SourceSpan,
} from "@eido/schemas"

export type DueSoonEntry = CoreApiTodayDueSoon["entries"][number]

export interface FilterEntity {
  id: string
  name: string
  kind?: string
  tag?: string
}

export const DUE_SOON_URL = "/api/core/today/due-soon"
export const ENTITIES_URL = "/api/core/entities"
export const DUE_SOON_DESKTOP_LIMIT = 5
export const DUE_SOON_PHONE_LIMIT = 3
export const LOCAL_STORAGE_ENTITY_KEY = "eido-today-entity"

export interface DueTextResult {
  text: string
  isOverdue: boolean
}

const MONTH_NAMES = [
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
] as const

/**
 * Calculates due date display text in long (desktop) and short (phone) forms.
 * - Overdue shows "N days overdue" in red (short: "N d overdue").
 * - Due within 30 days shows "Mon D · in N days" (short: "Mon D").
 * - Otherwise date alone ("Mon D"), with the year only when not the current year.
 */
export function formatDueText(
  dueAt: string,
  now: Date,
  form: "long" | "short"
): DueTextResult {
  const [yearStr, monthStr, dayStr] = dueAt.split("-")
  const dueYear = Number(yearStr)
  const dueMonth = Number(monthStr) - 1
  const dueDay = Number(dayStr)

  const nowYear = now.getFullYear()
  const nowMonth = now.getMonth()
  const nowDay = now.getDate()

  const dueDateUtc = Date.UTC(dueYear, dueMonth, dueDay)
  const nowDateUtc = Date.UTC(nowYear, nowMonth, nowDay)
  const diffDays = Math.round((dueDateUtc - nowDateUtc) / 86_400_000)

  const mon = MONTH_NAMES[dueMonth] ?? ""
  const monD = `${mon} ${dueDay}`
  const monDYear = dueYear === nowYear ? monD : `${monD}, ${dueYear}`

  if (diffDays < 0) {
    const days = Math.abs(diffDays)
    return {
      text:
        form === "short"
          ? `${days} d overdue`
          : `${days} ${days === 1 ? "day" : "days"} overdue`,
      isOverdue: true,
    }
  }

  if (diffDays <= 30) {
    if (form === "short") {
      return {
        text: monDYear,
        isOverdue: false,
      }
    }
    const daysLabel = diffDays === 1 ? "day" : "days"
    return {
      text: `${monDYear} · in ${diffDays} ${daysLabel}`,
      isOverdue: false,
    }
  }

  return {
    text: monDYear,
    isOverdue: false,
  }
}

export type StatusChipVariant = "draft-ready" | "tracking" | "open" | "neutral"

export interface StatusChipResult {
  label: string
  variant: StatusChipVariant
}

/**
 * Maps obligation status to design status chip:
 * - Draft ready (orange): open obligation with pending proactive intent
 * - Tracking (blue): open obligation with direction = 'waiting'
 * - Open (neutral): any other open obligation
 * - Done / Dismissed: neutral
 * - Any unexpected status renders with raw text
 */
export function obligationStatusChip(options: {
  status?: string
  direction?: "owed" | "waiting" | null
  hasPendingDraft?: boolean
}): StatusChipResult {
  const status = options.status ?? "open"
  if (status === "open") {
    if (options.hasPendingDraft) {
      return { label: "Draft ready", variant: "draft-ready" }
    }
    if (options.direction === "waiting") {
      return { label: "Tracking", variant: "tracking" }
    }
    return { label: "Open", variant: "open" }
  }
  if (status === "done") {
    return { label: "Done", variant: "neutral" }
  }
  if (status === "dismissed") {
    return { label: "Dismissed", variant: "neutral" }
  }
  return { label: status, variant: "neutral" }
}

/** Filter entries by entity ID, or return all when entityId is "all" or empty. */
export function filterDueSoon(
  entries: readonly DueSoonEntry[],
  entityId: string
): DueSoonEntry[] {
  if (!entityId || entityId === "all") return [...entries]
  return entries.filter((entry) => entry.entity.id === entityId)
}

/** Sort obligations by due date ascending (overdue first), then by id. */
export function sortDueSoon(entries: readonly DueSoonEntry[]): DueSoonEntry[] {
  return [...entries].sort((a, b) => {
    if (a.dueAt !== b.dueAt) {
      return a.dueAt.localeCompare(b.dueAt)
    }
    return a.id - b.id
  })
}

/** Limit obligations for desktop (5) or phone (3). */
export function limitDueSoon(
  entries: readonly DueSoonEntry[],
  limit: number
): DueSoonEntry[] {
  return entries.slice(0, limit)
}

/** Builds the URL to view the source document at the given span. */
export function documentSpanUrl(documentId: string, span: SourceSpan): string {
  return `/documents/${documentId}?start=${span.start}&end=${span.end}`
}

export type DueSoonState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unauthenticated" }
  | {
      status: "ready"
      entries: DueSoonEntry[]
      entities: FilterEntity[]
    }

export async function loadDueSoon(
  signal: AbortSignal,
  entityId?: string
): Promise<
  | { status: "ok"; data: CoreApiTodayDueSoon }
  | { status: "unauthenticated" }
  | { status: "error" }
> {
  try {
    const url = new URL(DUE_SOON_URL, window.location.origin)
    if (entityId && entityId !== "all") {
      url.searchParams.set("entity", entityId)
    }
    const response = await fetch(url.toString(), { cache: "no-store", signal })
    if (response.status === 401) return { status: "unauthenticated" }
    if (!response.ok) return { status: "error" }
    const parsed = validateCoreApiTodayDueSoon(await response.json())
    return parsed.ok
      ? { status: "ok", data: parsed.value }
      : { status: "error" }
  } catch {
    return { status: "error" }
  }
}

export async function loadEntities(
  signal: AbortSignal
): Promise<
  | { status: "ok"; entities: CoreApiEntityList["entities"] }
  | { status: "unauthenticated" }
  | { status: "error" }
> {
  try {
    const response = await fetch(ENTITIES_URL, { cache: "no-store", signal })
    if (response.status === 401) return { status: "unauthenticated" }
    if (!response.ok) return { status: "error" }
    const parsed = validateCoreApiEntityList(await response.json())
    return parsed.ok
      ? { status: "ok", entities: parsed.value.entities }
      : { status: "error" }
  } catch {
    return { status: "error" }
  }
}
