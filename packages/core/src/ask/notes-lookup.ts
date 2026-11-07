import type { AskFigure } from "@eido/schemas"
import {
  DEFAULT_NOTE_ROOTS,
  readNotesCoverage,
  searchLocalNotes,
  sliceNoteExcerpt,
} from "../connectors/files"
import type { AskCitation, AskDeps, AskResult } from "./types"

const NOTE_DIRECT_LOOKUP_PATTERN =
  /\b(?:have\s+i\s+(?:noted|written|wrote|jotted)|did\s+i\s+(?:note|write|jot)|what\s+did\s+i\s+(?:note|write|jot)|i'?ve\s+(?:noted|written|jotted)|(?:anything|something)\s+(?:i\s+|i'?ve\s+)?(?:noted|written|wrote|jotted)|i\s+(?:wrote|jotted)\s+down|in\s+my\s+(?:(?:private|own|local)\s+)?notes|my\s+(?:(?:private|own|local)\s+)?notes\s+(?:say|mention|have)|what(?:'s|\s+is)\s+in\s+my\s+(?:(?:private|own|local)\s+)?notes|(?:search|look\s+up(?:\s+in)?|check|find\s+in|show(?:\s+me)?)\s+my\s+(?:(?:private|own|local)\s+)?notes|(?:any\s+)?notes\s+(?:about|on|regarding))\b/i

const NOTE_SYNTHESIS_WORK_PATTERN =
  /\b(?:summar\w*|based\s+on|turn(?:\s+my\s+notes)?\s+into|synthes\w*|draft|compare|match|rewrite|explain|format|action\s+plan|proposal|create|compose)\b/i

/**
 * Returns true when the request asks directly what is recorded in local notes,
 * without asking to synthesize, transform, or draft from them.
 */
export function isDirectNoteLookup(question: string): boolean {
  const folded = question.toLowerCase().replace(/[’‘]/g, "'")
  return (
    NOTE_DIRECT_LOOKUP_PATTERN.test(folded) &&
    !NOTE_SYNTHESIS_WORK_PATTERN.test(folded)
  )
}

/**
 * Extracts the search terms from a direct notes question, stripping conversational
 * prefixes and notes boilerplate.
 */
export function extractNoteSearchQuery(question: string): string {
  let cleaned = question
    .trim()
    .replace(/[?!."']+$/, "")
    .trim()

  cleaned = cleaned
    .replace(
      /^(?:search|check|find\s+in|look\s+up\s+in)\s+my\s+(?:(?:private|own|local)\s+)?notes\s+(?:for\s+)?/i,
      ""
    )
    .replace(
      /^(?:look\s+up\s+)(.*?)(?:\s+in\s+my\s+(?:(?:private|own|local)\s+)?notes)$/i,
      "$1"
    )
    .replace(
      /^(?:what\s+did\s+i\s+(?:note|write|jot)(?:\s+(?:anything|something))?(?:\s+down)?\s*(?:about|on|regarding)?\s+)/i,
      ""
    )
    .replace(
      /^(?:what\s+have\s+i\s+(?:noted|written|jotted)(?:\s+(?:anything|something))?(?:\s+down)?\s*(?:about|on|regarding)?\s+)/i,
      ""
    )
    .replace(
      /^(?:did\s+i\s+(?:note|write|jot)(?:\s+(?:anything|something))?(?:\s+down)?\s*(?:about|on|regarding)?\s+)/i,
      ""
    )
    .replace(
      /^(?:have\s+i\s+(?:noted|written|jotted)(?:\s+(?:anything|something))?(?:\s+down)?\s*(?:about|on|regarding)?\s+)/i,
      ""
    )
    .replace(
      /^(?:what\s+do\s+my\s+(?:(?:private|own|local)\s+)?notes\s+(?:say|mention)\s+(?:about|on|regarding)\s+)/i,
      ""
    )
    .replace(
      /^(?:what(?:'s|\s+is)\s+in\s+my\s+(?:(?:private|own|local)\s+)?notes\s+(?:about|on|regarding)\s+)/i,
      ""
    )
    .replace(
      /^(?:in\s+my\s+(?:(?:private|own|local)\s+)?notes(?:,\s*|\s+))(?:what\s+did\s+i\s+(?:note|write|jot)(?:\s+down)?\s+(?:about|on|regarding)\s+)?/i,
      ""
    )
    .replace(/^(?:(?:any\s+)?notes\s+(?:about|on|regarding)\s+)/i, "")
    .replace(
      /^(?:show(?:\s+me)?\s+my\s+(?:(?:private|own|local)\s+)?notes\s+(?:about|on|regarding)\s+)/i,
      ""
    )

  // Strip remaining inline notes mentions if any
  cleaned = cleaned
    .replace(/\b(?:in\s+my\s+(?:(?:private|own|local)\s+)?notes)\b/gi, "")
    .trim()

  // Strip leading articles
  cleaned = cleaned.replace(/^(?:the|a|an)\s+/i, "").trim()

  const normalized = cleaned.toLowerCase().replace(/[’‘]/g, "'")
  if (
    normalized === "what's" ||
    normalized === "what is" ||
    normalized === "what" ||
    normalized === "what's in my notes" ||
    normalized === "what is in my notes" ||
    normalized === "my notes" ||
    normalized === "notes"
  ) {
    return ""
  }

  return cleaned.replace(/^[,\s:]+|[,\s:]+$/g, "").trim()
}

function figures(
  searched: number,
  matched: number,
  readInFull: number
): AskFigure[] {
  return [
    { key: "matched", value: matched, location: "/coverage/matched" },
    { key: "searched", value: searched, location: "/coverage/searched" },
    { key: "readInFull", value: readInFull, location: "/coverage/readInFull" },
  ]
}

/**
 * Answers a direct note lookup question straight from local notes in SQLite,
 * without invoking any model inference or foreground queue job.
 */
export async function directNoteLookup(
  question: string,
  deps: AskDeps
): Promise<AskResult> {
  const noteRoots = deps.noteRoots ?? DEFAULT_NOTE_ROOTS
  const now = deps.now ? deps.now().getTime() : Date.now()

  const coverage = readNotesCoverage(deps.db, {
    noteRoots,
    maxStaleMs: deps.maxNotesStaleMs,
    approvedRoots: deps.approvedNoteRoots,
    now,
  })

  // 1. Source missing: no approved or indexed note root
  if (coverage.status === "source_missing") {
    return {
      status: "refused",
      answer: "",
      citations: [],
      coverage: {
        searched: 0,
        matched: 0,
        readInFull: 0,
        readPartially: 0,
        notRead: 0,
        label: "No local notes source is configured or indexed.",
      },
      facts: { matchCount: 0 },
      figures: figures(0, 0, 0),
      followUps: [],
      droppedTags: [],
      possiblyTruncated: false,
      reason: "no local notes source is configured or indexed",
    }
  }

  // 2. Index stale with 0 notes: un-synced or empty stale index
  if (coverage.status === "index_stale" && coverage.noteCount === 0) {
    return {
      status: "refused",
      answer: "",
      citations: [],
      coverage: {
        searched: 0,
        matched: 0,
        readInFull: 0,
        readPartially: 0,
        notRead: 0,
        label: "Local notes index is not yet synced.",
      },
      facts: { matchCount: 0 },
      figures: figures(0, 0, 0),
      followUps: [],
      droppedTags: [],
      possiblyTruncated: false,
      reason: "local notes index is not yet synced",
    }
  }

  // 3. Search the live note records
  const query = extractNoteSearchQuery(question)
  const hits = searchLocalNotes(deps.db, query, {
    noteRoots,
    limit: deps.searchLimit ?? 20,
  })

  let qualification = ""
  if (coverage.status === "partial_sync") {
    qualification = ` (partial sync: ${String(coverage.skippedCount)} skipped)`
  } else if (coverage.status === "index_stale") {
    const staleSince = coverage.lastSyncedAt ?? "earlier"
    qualification = ` (index stale since ${staleSince})`
  }

  if (hits.length === 0) {
    let noMatchAnswer = "No matching notes found."
    if (coverage.status === "partial_sync") {
      noMatchAnswer = `No matching notes found (partial sync: ${String(coverage.skippedCount)} files skipped).`
    } else if (coverage.status === "index_stale") {
      const staleSince = coverage.lastSyncedAt ?? "earlier"
      noMatchAnswer = `No matching notes found (index stale since ${staleSince}).`
    }

    const label = `0 matches over ${String(coverage.noteCount)} notes${qualification}`
    return {
      status: "no_match",
      answer: noMatchAnswer,
      citations: [],
      coverage: {
        searched: coverage.noteCount,
        matched: 0,
        readInFull: 0,
        readPartially: 0,
        notRead: 0,
        label,
      },
      facts: { matchCount: 0 },
      figures: figures(coverage.noteCount, 0, 0),
      followUps: [],
      droppedTags: [],
      possiblyTruncated: false,
    }
  }

  // Ensure each hit has a verified verbatim excerpt
  for (const hit of hits) {
    if (hit.excerpt === undefined) {
      hit.excerpt = sliceNoteExcerpt(hit, 0, hit.body.length)
    } else if (
      hit.body.slice(hit.excerpt.start, hit.excerpt.end) !== hit.excerpt.text
    ) {
      hit.excerpt = sliceNoteExcerpt(hit, 0, hit.body.length)
    }
  }

  // Build citations and check read coverage
  const citations: AskCitation[] = []
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!
    const tag = deps.allocateSourceTag
      ? await deps.allocateSourceTag(hit.sourceRef)
      : `[N${String(i + 1)}]`

    const exc = hit.excerpt!
    const isFull = exc.start === 0 && exc.end === hit.body.length

    citations.push({
      tag,
      documentId: hit.sha256,
      source: "files",
      sourceRef: hit.sourceRef,
      title: hit.title,
      occurredAt: hit.ingestedAt,
      ...(isFull
        ? {}
        : {
            excerpt: {
              passages: [{ start: exc.start, end: exc.end }],
              omittedChars: hit.body.length - (exc.end - exc.start),
            },
          }),
      injectionSuspected: false,
      injectionReasons: [],
    })
  }

  const readInFull = hits.filter(
    (h) => h.excerpt?.start === 0 && h.excerpt?.end === h.body.length
  ).length
  const readPartially = hits.length - readInFull

  const matchWord = hits.length === 1 ? "match" : "matches"
  const label = `${String(hits.length)} ${matchWord} over ${String(coverage.noteCount)} notes${qualification}`

  let header = "From your local notes:"
  if (coverage.status === "partial_sync") {
    header = `From your local notes (partial sync: ${String(coverage.skippedCount)} skipped):`
  } else if (coverage.status === "index_stale") {
    const staleSince = coverage.lastSyncedAt ?? "earlier"
    header = `From your local notes (index stale since ${staleSince}):`
  }

  const passages = hits.map((hit, i) => {
    const tag = citations[i]!.tag
    const exc = hit.excerpt!
    const lineNotice =
      exc.fromLine === exc.toLine
        ? `line ${String(exc.fromLine)}`
        : `lines ${String(exc.fromLine)}-${String(exc.toLine)}`
    const quoted = exc.text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n")
    return `${tag} (${hit.title}, ${lineNotice}):\n${quoted}`
  })

  const answer = `${header}\n\n${passages.join("\n\n")}`

  return {
    status: "answered",
    answer,
    citations,
    coverage: {
      searched: coverage.noteCount,
      matched: hits.length,
      readInFull,
      readPartially,
      notRead: 0,
      label,
    },
    facts: { matchCount: hits.length },
    figures: figures(coverage.noteCount, hits.length, readInFull),
    followUps: [],
    droppedTags: [],
    possiblyTruncated: false,
  }
}
