import {
  validateGateAuditChainStatus,
  validateGateAuditPage,
  validateGateIntentHistory,
  type GateAuditChainStatus,
  type GateAuditPage,
  type GateIntentHistory,
} from "@eido/schemas"

export type AuditEntry = GateAuditPage["entries"][number]
export type HistoryEntry = GateIntentHistory["entries"][number]

export const PAGE_SIZE = 50
export const AUDIT_URL = "/api/gate/audit"
export const CHAIN_URL = "/api/gate/audit/chain"

export const historyUrl = (intentId: string) =>
  `/api/gate/approvals/${encodeURIComponent(intentId)}/history`

/** The page's own route for an intent's history view. */
export const intentHref = (intentId: string) =>
  `/activity?intent=${encodeURIComponent(intentId)}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The gate records an intent's UUID as the target of that intent's rows. */
export function intentIdOf(entry: AuditEntry): string | null {
  return UUID.test(entry.target) ? entry.target : null
}

/** First 8 hex characters of the entry's detail hash. */
export const shortHash = (detailHash: string) => detailHash.slice(0, 8)

export type RowKind = "alert" | "refused" | "normal"

/** Verification mismatches are alerts; refusals and rejections are policy refusals. */
export function rowKind(action: string): RowKind {
  if (/^alert\.|mismatch/.test(action)) return "alert"
  if (/refus|reject|invalid|forbidden|disabled_/.test(action)) return "refused"
  return "normal"
}

export const ROW_KIND_LABEL: Readonly<Record<RowKind, string | null>> = {
  alert: "Alert",
  refused: "Refused",
  normal: null,
}

export const ACTOR_LABEL = { you: "you", auto: "auto", gate: "gate" } as const

/** "Oct 18, 2026, 9:04:12 AM" in the viewer's locale and time zone. */
export function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(iso))
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(
    new Date(iso)
  )
}

export type DayGroup = { key: string; label: string; entries: AuditEntry[] }

function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Groups entries (already newest first) by the viewer's local calendar day, keeping order.
 * The label is "Today" or "Yesterday" relative to `now`, else a long date.
 */
export function groupByDay(
  entries: readonly AuditEntry[],
  now: Date = new Date()
): DayGroup[] {
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const today = localDayKey(now)
  const prior = localDayKey(yesterday)
  const groups: DayGroup[] = []
  for (const entry of entries) {
    const date = new Date(entry.ts)
    const key = localDayKey(date)
    const last = groups.at(-1)
    if (last?.key === key) {
      last.entries.push(entry)
      continue
    }
    const label =
      key === today
        ? "Today"
        : key === prior
          ? "Yesterday"
          : new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(
              date
            )
    groups.push({ key, label, entries: [entry] })
  }
  return groups
}

/** Appends a loaded page to the list without duplicates; order stays newest first. */
export function mergePage(
  loaded: readonly AuditEntry[],
  page: readonly AuditEntry[]
): AuditEntry[] {
  const seen = new Set(loaded.map((entry) => entry.seq))
  return [...loaded, ...page.filter((entry) => !seen.has(entry.seq))]
}

/** The cursor for the next page: the lowest seq loaded, or null when the gate said there is no more. */
export function nextCursor(
  loaded: readonly AuditEntry[],
  nextBefore: number | undefined
): number | null {
  if (nextBefore === undefined || loaded.length === 0) return null
  return Math.min(...loaded.map((entry) => entry.seq))
}

/**
 * Folds a re-read first page into the loaded list: the fresh rows replace every loaded row
 * at or above the page's lowest seq (new rows and updated undo projections), and loaded
 * rows below it stay. The cursor is the loaded one while older rows remain, else the page's.
 */
export function mergeRefresh(
  loaded: readonly AuditEntry[],
  cursor: number | null,
  fresh: readonly AuditEntry[],
  freshNextBefore: number | undefined
): { entries: AuditEntry[]; cursor: number | null } {
  if (fresh.length === 0) return { entries: [...loaded], cursor }
  const floor = Math.min(...fresh.map((entry) => entry.seq))
  const older = loaded.filter((entry) => entry.seq < floor)
  return {
    entries: [...fresh, ...older],
    cursor: older.length > 0 ? cursor : nextCursor(fresh, freshNextBefore),
  }
}

export function chainBrokenMessage(
  status: Extract<GateAuditChainStatus, { ok: false }>
): string {
  return status.brokenAtSeq >= 1
    ? `Audit chain broken at entry ${status.brokenAtSeq}. Log entries after this point cannot be trusted.`
    : "Audit chain failed verification."
}

type Failure =
  { status: "offline" } | { status: "unauthenticated" } | { status: "error" }

export type ChainLoad =
  { status: "ready"; chain: GateAuditChainStatus } | Failure
export type AuditLoad =
  | { status: "ready"; entries: AuditEntry[]; nextBefore: number | undefined }
  | Failure
export type HistoryLoad = { status: "ready"; entries: HistoryEntry[] } | Failure

/**
 * One GET through the gate. Nothing read here is written to the device: audit data is
 * sensitive, so there is no cache and no storage. A TypeError is fetch's network failure.
 */
async function read<T>(
  url: string,
  signal: AbortSignal,
  validate: (body: unknown) => { ok: true; value: T } | { ok: false },
  whenNotFound?: T
): Promise<{ status: "ready"; value: T } | Failure> {
  try {
    const response = await fetch(url, { cache: "no-store", signal })
    if (response.status === 401) return { status: "unauthenticated" }
    if (response.status === 404 && whenNotFound !== undefined)
      return { status: "ready", value: whenNotFound }
    if (!response.ok) return { status: "error" }
    const parsed = validate(await response.json())
    return parsed.ok
      ? { status: "ready", value: parsed.value }
      : { status: "error" }
  } catch (error) {
    if (!signal.aborted && error instanceof TypeError)
      return { status: "offline" }
    return { status: "error" }
  }
}

export async function loadChain(signal: AbortSignal): Promise<ChainLoad> {
  const result = await read(CHAIN_URL, signal, validateGateAuditChainStatus)
  return result.status === "ready"
    ? { status: "ready", chain: result.value }
    : result
}

export async function loadAudit(
  signal: AbortSignal,
  before?: number
): Promise<AuditLoad> {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (before !== undefined) query.set("before", String(before))
  const result = await read(
    `${AUDIT_URL}?${query}`,
    signal,
    validateGateAuditPage
  )
  return result.status === "ready"
    ? {
        status: "ready",
        entries: result.value.entries,
        nextBefore: result.value.nextBefore,
      }
    : result
}

export async function loadHistory(
  intentId: string,
  signal: AbortSignal
): Promise<HistoryLoad> {
  // The gate answers 404 for an id that is not an intent: it has no history to show.
  const result = await read(
    historyUrl(intentId),
    signal,
    validateGateIntentHistory,
    { intentId, entries: [] }
  )
  return result.status === "ready"
    ? { status: "ready", entries: result.value.entries }
    : result
}
