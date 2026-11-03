// Hierarchical context for long threads and documents: section summaries first, then verified raw
// passages. Pure selection over stored text; no model call. A digest is a lossy summary, so it
// never decides an existence question: the raw search over every section does (`rawSearch`).
import type { DatabaseSync } from "node:sqlite"
import type { Cite, Digest } from "../digest/types"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"
import { tokenize } from "../index/text"
import { paragraphs, termHits } from "./passages"
import type { Passage } from "./passages"

/**
 * One section of a source: a message of a thread or a page of a document, as the range
 * `[start, end)` of the stored body `document_text.body` of document `sha256`. `id` is the digest
 * cite id of the section (see `citeSectionId`).
 */
export interface ZoomSection {
  id: string
  sha256: string
  start: number
  end: number
}

/** The id a digest cite gives its section: the message id, or `${docSha256}#${page}`. */
export function citeSectionId(cite: Cite): string {
  return "messageId" in cite
    ? cite.messageId
    : `${cite.docSha256}#${String(cite.page)}`
}

export interface ZoomInput {
  db: DatabaseSync
  sections: readonly ZoomSection[]
  /** The stored digest of the source, or undefined when none is stored (absent or pending). */
  digest: Digest | undefined
  /** The normalized query terms, as the raw search matches on them. */
  terms: ReadonlySet<string>
  /** Estimated tokens the selected material may use, labels included. */
  budgetTokens: number
  charsPerToken?: number
  /** An existence question: raw passages are placed before any summary. */
  existence?: boolean
  /** Share of the budget summaries may take before raw passages are placed. Default 0.4. */
  summaryShare?: number
  /** Longest raw opening taken from a section that has no summary. Default 600. */
  openingChars?: number
}

export type ZoomItem =
  | {
      kind: "summary"
      text: string
      /** The sections the line cites, as the digest recorded them. No offsets: a summary. */
      cites: { sectionId: string; sha256: string }[]
      tokens: number
    }
  | {
      kind: "passage" | "opening"
      sectionId: string
      sha256: string
      /** Offsets into `document_text.body` of `sha256`; `text` is exactly that slice. */
      start: number
      end: number
      text: string
      tokens: number
    }

export type OmitReason = "budget" | "outside_stored_body"

export interface ZoomSectionCoverage {
  sectionId: string
  /** 1 is the best-ranked section. */
  rank: number
  rawHits: number
  termMatches: number
  hasSummary: boolean
  summaryPlaced: boolean
  passages: number
  opening: boolean
  /** Set when nothing of the section is in the selection. */
  omitted?: OmitReason
}

export interface ZoomResult {
  items: ZoomItem[]
  tokens: number
  budgetTokens: number
  /** One entry per section, best first; no section is missing. */
  coverage: ZoomSectionCoverage[]
  digest: "used" | "absent"
  /** The code-run raw search over every section's stored text. */
  rawSearch: {
    searchedSections: number
    matchedSections: number
    hits: number
    /** True only when every section was searched and none held a query term. */
    noneFound: boolean
  }
}

interface Candidate {
  section: ZoomSection
  text: string
  rawHits: number
  termMatches: number
  lineIndexes: number[]
  rank: number
}

const labelFor = (kind: string, id: string): string => `[${kind} ${id}]\n`

function rawBody(db: DatabaseSync, sha256: string): string | undefined {
  const row = db
    .prepare("SELECT body FROM document_text WHERE sha256 = ?")
    .get(sha256)
  return typeof row?.["body"] === "string" ? row["body"] : undefined
}

/**
 * True when `text` is exactly the stored body's slice `[start, end)`. Every raw item is checked
 * this way before it is returned, so a passage is never taken on trust.
 */
export function verifyPassage(
  db: DatabaseSync,
  sha256: string,
  start: number,
  end: number,
  text: string
): boolean {
  const body = rawBody(db, sha256)
  return (
    body !== undefined &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= body.length &&
    body.slice(start, end) === text
  )
}

const distinct = (terms: Iterable<string>): Set<string> => new Set(terms)

/** Best first: raw hits, then digest term matches, then section id, so input order never counts. */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.rawHits !== b.rawHits) return b.rawHits - a.rawHits
  if (a.termMatches !== b.termMatches) return b.termMatches - a.termMatches
  return a.section.id < b.section.id ? -1 : a.section.id > b.section.id ? 1 : 0
}

/** A prefix of the section, ending at a paragraph boundary when one fits, else at `max` chars. */
function openingOf(text: string, max: number): Passage | undefined {
  if (text.trim() === "") return undefined
  const lead = text.length - text.trimStart().length
  const paras = paragraphs(text)
  let end = 0
  for (const p of paras) {
    if (p.end > max) break
    end = p.end
  }
  if (end === 0) end = Math.min(text.length, lead + max)
  return end > lead ? { start: lead, end } : undefined
}

export function selectZoomContext(input: ZoomInput): ZoomResult {
  const { db, budgetTokens, terms } = input
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const summaryShare = input.summaryShare ?? 0.4
  const openingChars = input.openingChars ?? 600
  const queryTerms = distinct(terms)
  const lines = input.digest?.lines ?? []
  const sectionIds = new Set(input.sections.map((s) => s.id))

  // A line whose cites name no section of this source cannot be checked, so it is left out.
  const checkedLines = lines.flatMap((line, index) => {
    const ids = [...new Set(line.cites.map(citeSectionId))].filter((id) =>
      sectionIds.has(id)
    )
    return ids.length === 0 ? [] : [{ index, text: line.text, ids }]
  })

  const candidates: Candidate[] = []
  const outside: ZoomSection[] = []
  for (const section of input.sections) {
    const body = rawBody(db, section.sha256)
    if (
      body === undefined ||
      section.start < 0 ||
      section.end > body.length ||
      section.end <= section.start
    ) {
      outside.push(section)
      continue
    }
    const text = body.slice(section.start, section.end)
    const own = checkedLines.filter((l) => l.ids.includes(section.id))
    const digestTerms = new Set(
      own.flatMap((l) => tokenize(l.text)).filter((t) => queryTerms.has(t))
    )
    candidates.push({
      section,
      text,
      rawHits: termHits(text, queryTerms),
      termMatches: digestTerms.size,
      lineIndexes: own.map((l) => l.index),
      rank: 0,
    })
  }
  candidates.sort(compareCandidates)
  candidates.forEach((c, i) => {
    c.rank = i + 1
  })
  const byId = new Map(candidates.map((c) => [c.section.id, c]))

  const items: ZoomItem[] = []
  let used = 0
  const place = (item: ZoomItem): boolean => {
    if (used + item.tokens > budgetTokens) return false
    used += item.tokens
    items.push(item)
    return true
  }
  const placedSummary = new Set<string>()
  const passageCount = new Map<string, number>()
  const openingFor = new Set<string>()

  // A line belongs to the best-ranked section it cites; it is placed once.
  function placeSummaries(limit: number): void {
    const owned = checkedLines
      .map((line) => {
        const owner = line.ids
          .map((id) => byId.get(id))
          .filter((c): c is Candidate => c !== undefined)
          .sort(compareCandidates)[0]
        return { line, owner }
      })
      .flatMap(({ line, owner }) =>
        owner === undefined ? [] : [{ line, owner }]
      )
      .sort(
        (a, b) =>
          compareCandidates(a.owner, b.owner) || a.line.index - b.line.index
      )
    const startUsed = used
    for (const { line } of owned) {
      const text = `${labelFor("summary", line.ids.join(","))}${line.text}`
      const tokens = estimateTokens(text, charsPerToken)
      if (used - startUsed + tokens > limit || used + tokens > budgetTokens)
        continue
      place({
        kind: "summary",
        text: line.text,
        cites: line.ids.flatMap((id) => {
          const c = byId.get(id)
          return c === undefined
            ? []
            : [{ sectionId: id, sha256: c.section.sha256 }]
        }),
        tokens,
      })
      for (const id of line.ids) placedSummary.add(id)
    }
  }

  function placePassages(): void {
    for (const c of candidates) {
      if (c.rawHits === 0) continue
      const hitParagraphs = paragraphs(c.text)
        .map((p) => ({
          p,
          hits: termHits(c.text.slice(p.start, p.end), queryTerms),
        }))
        .filter(({ hits }) => hits > 0)
        .sort((a, b) => b.hits - a.hits || a.p.start - b.p.start)
      for (const { p } of hitParagraphs) {
        const start = c.section.start + p.start
        const end = c.section.start + p.end
        const text = c.text.slice(p.start, p.end)
        const tokens = estimateTokens(
          `${labelFor("passage", c.section.id)}${text}`,
          charsPerToken
        )
        if (!verifyPassage(db, c.section.sha256, start, end, text)) continue
        if (
          place({
            kind: "passage",
            sectionId: c.section.id,
            sha256: c.section.sha256,
            start,
            end,
            text,
            tokens,
          })
        )
          passageCount.set(
            c.section.id,
            (passageCount.get(c.section.id) ?? 0) + 1
          )
      }
    }
  }

  function placeOpenings(): void {
    for (const c of candidates) {
      if (c.lineIndexes.length > 0 || passageCount.has(c.section.id)) continue
      const opening = openingOf(c.text, openingChars)
      if (opening === undefined) continue
      const start = c.section.start + opening.start
      const end = c.section.start + opening.end
      const text = c.text.slice(opening.start, opening.end)
      if (!verifyPassage(db, c.section.sha256, start, end, text)) continue
      const tokens = estimateTokens(
        `${labelFor("opening", c.section.id)}${text}`,
        charsPerToken
      )
      if (
        place({
          kind: "opening",
          sectionId: c.section.id,
          sha256: c.section.sha256,
          start,
          end,
          text,
          tokens,
        })
      )
        openingFor.add(c.section.id)
    }
  }

  const summaryLimit = Math.floor(budgetTokens * summaryShare)
  if (input.existence === true) {
    placePassages()
    placeSummaries(budgetTokens)
  } else {
    placeSummaries(summaryLimit)
    placePassages()
  }
  placeOpenings()

  const coverage: ZoomSectionCoverage[] = candidates.map((c) => {
    const passages = passageCount.get(c.section.id) ?? 0
    const summaryPlaced = placedSummary.has(c.section.id)
    const opening = openingFor.has(c.section.id)
    return {
      sectionId: c.section.id,
      rank: c.rank,
      rawHits: c.rawHits,
      termMatches: c.termMatches,
      hasSummary: c.lineIndexes.length > 0,
      summaryPlaced,
      passages,
      opening,
      ...(!summaryPlaced && passages === 0 && !opening
        ? { omitted: "budget" as const }
        : {}),
    }
  })
  for (const section of outside) {
    coverage.push({
      sectionId: section.id,
      rank: 0,
      rawHits: 0,
      termMatches: 0,
      hasSummary: false,
      summaryPlaced: false,
      passages: 0,
      opening: false,
      omitted: "outside_stored_body",
    })
  }

  const hits = candidates.reduce((sum, c) => sum + c.rawHits, 0)
  return {
    items,
    tokens: used,
    budgetTokens,
    coverage,
    digest: checkedLines.length > 0 ? "used" : "absent",
    rawSearch: {
      searchedSections: candidates.length,
      matchedSections: candidates.filter((c) => c.rawHits > 0).length,
      hits,
      noneFound: outside.length === 0 && hits === 0,
    },
  }
}
