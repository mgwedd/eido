import type { DatabaseSync } from "node:sqlite"
import type { CoreApiBrief, CoreApiError, SourceSpan } from "@eido/schemas"
import { getBrief, getLatestBrief } from "../brief/index"
import type { Brief, BriefLine } from "../brief/index"

/** GET /brief/latest and GET /brief/:date (#480). */
export const BRIEF_PATH = /^\/brief\/([^/]+)$/

export type BriefRouteResult =
  | { ok: true; body: CoreApiBrief }
  | { ok: false; code: CoreApiError["error"]["code"]; message: string }

const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/

/** True for a real calendar date written YYYY-MM-DD ("2026-02-30" is not one). */
function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value)
  if (match === null) return false
  const [year, month, day] = [match[1], match[2], match[3]].map(Number)
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === (month ?? 1) - 1 &&
    parsed.getUTCDate() === day
  )
}

function toLine(line: BriefLine): CoreApiBrief["lines"][number] {
  if (line.kind === "more") return line
  const span: SourceSpan = {
    start: line.source.start,
    end: line.source.end,
    ...(line.source.messageId === undefined
      ? {}
      : { message_id: line.source.messageId }),
    ...(line.source.page === undefined ? {} : { page: line.source.page }),
  }
  return {
    kind: line.kind,
    text: line.text,
    ledger: line.ledger,
    source: { documentId: line.source.docSha256, span },
    ...(line.detail === undefined
      ? {}
      : {
          detail: {
            text: line.detail.text,
            cites: line.detail.cites.map((cite) =>
              "messageId" in cite
                ? { messageId: cite.messageId }
                : { documentId: cite.docSha256, page: cite.page }
            ),
          },
        }),
  }
}

function toBody(brief: Brief): CoreApiBrief {
  return {
    id: brief.id,
    date: brief.forDate,
    generatedAt: brief.generatedAt,
    windowStart: brief.windowStart,
    windowEnd: brief.windowEnd,
    lines: brief.lines.map(toLine),
    coverage: brief.coverage,
    coverageLine: brief.coverageLine,
  }
}

/** Serves the stored brief named by a path that matched BRIEF_PATH: "latest" or a local date. */
export function briefRoute(
  db: DatabaseSync,
  match: RegExpExecArray
): BriefRouteResult {
  let key: string
  try {
    key = decodeURIComponent(match[1] ?? "")
  } catch {
    return { ok: false, code: "bad_request", message: "malformed date" }
  }
  if (key !== "latest" && !isCalendarDate(key)) {
    return {
      ok: false,
      code: "bad_request",
      message: "date must be a calendar date, YYYY-MM-DD",
    }
  }
  const brief = key === "latest" ? getLatestBrief(db) : getBrief(db, key)
  if (brief === undefined) {
    return { ok: false, code: "not_found", message: "no such brief" }
  }
  return { ok: true, body: toBody(brief) }
}
