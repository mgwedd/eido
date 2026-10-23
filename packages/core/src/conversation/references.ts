import type { Preserved } from "./types"

// Dates and source tags are extracted by code, never trusted to the model.

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
const ORDINAL = "(?:st|nd|rd|th)?"

const DATE_PATTERNS: readonly RegExp[] = [
  // ISO: 2025-10-31, optionally with a time.
  /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  // Oct 31, Oct. 31st, October 31, 2025
  new RegExp(`\\b${MONTH}\\.? \\d{1,2}${ORDINAL}(?:,? \\d{4})?\\b(?!:)`, "gi"),
  // 31 October, 31st Oct 2025
  new RegExp(`\\b\\d{1,2}${ORDINAL} ${MONTH}\\b\\.?(?: \\d{4})?\\b`, "gi"),
]

// A tag is written in brackets in answers and summaries: [M3].
const BRACKETED_TAG = /\[([A-Z]{1,3}\d{1,4})\]/g

/** Every date in `text`, as written, in order of appearance, without repeats. */
export function extractDates(text: string): string[] {
  const found: { index: number; text: string }[] = []
  for (const pattern of DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.push({ index: match.index, text: match[0].replace(/\.$/, "") })
    }
  }
  found.sort((a, b) => a.index - b.index)
  return unique(found.map((f) => f.text))
}

/** Every bracketed source tag in `text`, without repeats. */
export function extractTags(text: string): string[] {
  return unique([...text.matchAll(BRACKETED_TAG)].map((m) => m[1] ?? ""))
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => v !== ""))]
}

const squash = (s: string): string => s.replace(/\s+/g, " ").toLowerCase()

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function summaryHasDate(summary: string, date: string): boolean {
  return squash(summary).includes(squash(date))
}

/** A tag counts as present as a whole token, so "M3" is not found inside "M30". */
export function summaryHasTag(summary: string, tag: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(tag)}(?![A-Za-z0-9])`).test(
    summary
  )
}

export const PRESERVED_PREFIX = "Preserved references: "

/** The references to carry forward from `text` and `sources`: dates and tags, deduplicated. */
export function collectReferences(
  texts: readonly string[],
  sources: readonly string[]
): Preserved {
  const dates: string[] = []
  const tags: string[] = [...sources]
  for (const text of texts) {
    dates.push(...extractDates(text))
    tags.push(...extractTags(text))
  }
  return { dates: unique(dates), tags: unique(tags) }
}

/**
 * `summary` with every reference of `needed` it does not already contain appended on a final
 * `Preserved references: ...` line. Survival does not depend on the model.
 */
export function withPreservedReferences(
  summary: string,
  needed: Preserved
): string {
  const missing = [
    ...needed.dates.filter((d) => !summaryHasDate(summary, d)),
    ...needed.tags.filter((t) => !summaryHasTag(summary, t)),
  ]
  if (missing.length === 0) return summary
  return `${summary}\n${PRESERVED_PREFIX}${missing.join("; ")}`
}
