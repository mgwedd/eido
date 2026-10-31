import type { DatabaseSync } from "node:sqlite"
import type { OffsetTable } from "../parsers/types"

/**
 * The text of a stored document exactly as `document_text.body` holds it, with an offset table
 * built from that string. Extraction reads this, never a fresh parse of the original, so every
 * span it stores indexes the text the document viewer renders.
 */
export type StoredText = { text: string; offsets: OffsetTable }

type PageRange = { page: number; start: number; end: number }

/**
 * Where each stored page's text sits in `body`. Pages are located in order, so a page repeated
 * word for word still resolves to its own place. A page whose text is not found in the body
 * (for example, one the body was edited after) gets no range; its lines carry no page.
 */
function pageRanges(
  body: string,
  pages: readonly { page: number; text: string }[]
): PageRange[] {
  const ranges: PageRange[] = []
  let cursor = 0
  for (const { page, text } of pages) {
    if (text === "") continue
    const start = body.indexOf(text, cursor)
    if (start === -1) continue
    const end = start + text.length
    ranges.push({ page, start, end })
    cursor = end
  }
  return ranges
}

/**
 * Builds the offset table for `body`: one entry per line, split on "\n" as the viewer splits it
 * (`documents-route.ts`). A line inside a page range carries that page and counts from 1 within
 * the page; any other line counts from 1 within the stretch since the last page boundary.
 */
export function buildStoredOffsets(
  body: string,
  pages: readonly { page: number; text: string }[],
  messageId?: string
): OffsetTable {
  const ranges = pageRanges(body, pages)
  const offsets: OffsetTable = []
  let rangeIndex = 0
  let currentPage: number | undefined
  let line = 0
  let offset = 0
  for (const lineText of body.split("\n")) {
    while (
      ranges[rangeIndex] !== undefined &&
      ranges[rangeIndex]!.end < offset
    ) {
      rangeIndex += 1
    }
    const range = ranges[rangeIndex]
    const page =
      range !== undefined && range.start <= offset && offset <= range.end
        ? range.page
        : undefined
    if (offsets.length === 0 || page !== currentPage) line = 0
    currentPage = page
    line += 1
    offsets.push({
      offset,
      ...(messageId === undefined ? {} : { messageId }),
      ...(page === undefined ? {} : { page }),
      line,
    })
    offset += lineText.length + 1
  }
  return offsets
}

/** Reads a document's stored body and pages; null when it has no `document_text` row. */
export function loadStoredText(
  db: DatabaseSync,
  sha256: string
): StoredText | null {
  const row = db
    .prepare("SELECT body, message_id FROM document_text WHERE sha256 = ?")
    .get(sha256)
  if (row === undefined) return null
  const body = String(row["body"])
  const pages = db
    .prepare(
      "SELECT page, text FROM document_pages WHERE sha256 = ? ORDER BY page"
    )
    .all(sha256)
    .map((p) => ({ page: Number(p["page"]), text: String(p["text"]) }))
  const messageId =
    row["message_id"] === null ? undefined : String(row["message_id"])
  return { text: body, offsets: buildStoredOffsets(body, pages, messageId) }
}
