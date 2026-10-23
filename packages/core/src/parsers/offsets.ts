import type { OffsetEntry, OffsetTable } from "./types"

/** A line of parsed text with where it came from; `line` is numbered by `buildText`. */
export type SourceLine = {
  text: string
  messageId?: string
  part?: string
  page?: number
}

/** A run of lines that share one source; its lines are numbered from 1. */
export type Section = Omit<SourceLine, "text"> & { lines: string[] }

/**
 * Joins the sections' lines with "\n" and records one offset entry per line. The returned text
 * is final: nothing may change it after the table is built, or the offsets stop matching.
 */
export function buildText(sections: readonly Section[]): {
  text: string
  offsets: OffsetTable
} {
  const offsets: OffsetTable = []
  const parts: string[] = []
  let offset = 0
  for (const { lines, ...source } of sections) {
    lines.forEach((line, index) => {
      if (parts.length > 0) offset += 1 // the "\n" before this line
      offsets.push({ offset, ...source, line: index + 1 })
      parts.push(line)
      offset += line.length
    })
  }
  return { text: parts.join("\n"), offsets }
}

/** The entry for the line holding character `offset`, by binary search; null before any line. */
export function lookupOffset(
  table: OffsetTable,
  offset: number
): OffsetEntry | null {
  let low = 0
  let high = table.length - 1
  let found: OffsetEntry | null = null
  while (low <= high) {
    const mid = (low + high) >> 1
    // low <= mid <= high < table.length, so the index is always in range.
    const entry = table[mid]!
    if (entry.offset <= offset) {
      found = entry
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/** Splits text into lines on CRLF, CR or LF. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}
