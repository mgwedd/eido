import type { Cite } from "../digest/types"

/** Where a line's facts come from in the ledger. */
export type BriefLedgerRef = {
  type: "obligation" | "extraction"
  id: string
}

/** The quote the ledger row was read from. */
export type BriefSource = {
  docSha256: string
  messageId?: string
  page?: number
  start: number
  end: number
}

/** One item of the brief. Its text is built by code from ledger fields; no model writes it. */
export type BriefItemLine = {
  text: string
  kind: "overdue" | "due" | "changed" | "needs-you"
  ledger: BriefLedgerRef
  source: BriefSource
  /** The first line of a cached digest of the same document or thread, with its cites. */
  detail?: { text: string; cites: Cite[] }
}

/** Replaces the items beyond `maxLines`; it points at the ledger, which lists every one of them. */
export type BriefMoreLine = {
  text: string
  kind: "more"
  count: number
  ledger: { type: "ledger" }
}

export type BriefLine = BriefItemLine | BriefMoreLine

export type BriefCoverage = {
  messagesRead: number
  messagesTotal: number
  documentsRead: number
  documentsTotal: number
  windowStart: string
  windowEnd: string
  /** Ledger rows left out because they have no usable source. */
  skipped: number
}

export type Brief = {
  id: string
  /** Local calendar date, YYYY-MM-DD. */
  forDate: string
  generatedAt: string
  windowStart: string
  windowEnd: string
  lines: BriefLine[]
  coverage: BriefCoverage
  /** "Read N new messages and M documents since yesterday", built from `coverage`. */
  coverageLine: string
}

export type BriefConfig = {
  /** IANA timezone the brief's date and delivery time are read in. */
  timezone: string
  /** Local delivery time, `HH:MM`. */
  time: string
  /** Open obligations due within this many days of today are listed. */
  dueWithinDays: number
  /** Most lines a brief holds, including the "more" line. */
  maxLines: number
  /** An unconfirmed extraction field scoring below this is listed as "needs you". */
  confirmThreshold: number
}

export const DEFAULT_BRIEF_CONFIG: Omit<BriefConfig, "timezone"> = {
  time: "07:00",
  dueWithinDays: 14,
  maxLines: 8,
  confirmThreshold: 0.8,
}
