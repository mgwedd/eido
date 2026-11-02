// Passage selection for focused Ask requests: pure functions over a document body. Offsets are
// UTF-16 indexes into the indexed body (`document_text.body`), so a citation can point back at
// the exact text the model read.
import { tokenize } from "../index/text"

/** A body shorter than this is always read whole: excerpting it saves too little to matter. */
export const MIN_EXCERPT_BODY_CHARS = 1000

export interface Passage {
  start: number
  end: number
}

/** Paragraphs (runs of lines without a blank line between them) with their offsets in `body`. */
export function paragraphs(body: string): Passage[] {
  return [...body.matchAll(/[^\n]+(?:\n(?![ \t]*\n)[^\n]+)*/gu)].flatMap(
    (match) => {
      const text = match[0]
      return text.trim() === ""
        ? []
        : [{ start: match.index, end: match.index + text.length }]
    }
  )
}

/** How many of the text's terms are search terms. */
export function termHits(text: string, terms: ReadonlySet<string>): number {
  return tokenize(text).filter((term) => terms.has(term)).length
}

/**
 * The paragraphs of `body` that contain a search term, when together they are materially smaller
 * than the body (at most half of it, and the body at least `MIN_EXCERPT_BODY_CHARS` long).
 * Otherwise null: the whole body is the better context.
 */
export function matchingPassages(
  body: string,
  terms: ReadonlySet<string>
): Passage[] | null {
  if (body.length < MIN_EXCERPT_BODY_CHARS) return null
  const matching = paragraphs(body).filter(
    (p) => termHits(body.slice(p.start, p.end), terms) > 0
  )
  const chars = matching.reduce((sum, p) => sum + p.end - p.start, 0)
  return matching.length === 0 || chars * 2 > body.length ? null : matching
}

/** One candidate for a focused pack: a whole document, or one passage of it. */
export interface RankedUnit {
  sha256: string
  /** Search terms in the unit's text. */
  score: number
  /** The document's search rank score (BM25, higher is better). */
  searchScore: number
  occurredAt: string
  /** Absent for a whole document. */
  passage?: Passage
}

/**
 * Best first: more search terms in the unit, then the document's search score, then newest, then
 * sha256, then position in the body. Every key is a property of the unit, so the order never
 * depends on the order the candidates arrived in.
 */
export function compareUnits(a: RankedUnit, b: RankedUnit): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.searchScore !== b.searchScore) return b.searchScore - a.searchScore
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1
  if (a.sha256 !== b.sha256) return a.sha256 < b.sha256 ? -1 : 1
  return (a.passage?.start ?? 0) - (b.passage?.start ?? 0)
}
