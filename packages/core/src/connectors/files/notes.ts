import type { DatabaseSync } from "node:sqlite"
import { LIVE_DOCUMENT_PREDICATE } from "../../index/heads"

export const DEFAULT_NOTE_ROOTS = ["notes"] as const
export const NOTE_MIMES = ["text/markdown", "text/plain"] as const
export type NoteMime = (typeof NOTE_MIMES)[number]

export interface FileRootSyncCursor {
  /** True when any directory listing, file read, or scan budget was truncated or failed. */
  partial: boolean
  /** Total live files indexed in this root during the scan. */
  indexedFiles: number
  /** Total live note files (`text/markdown` or `text/plain`) indexed in this root. */
  noteCount: number
  /** Count of files or subdirectories skipped due to read/UTF-8 errors or scan limits. */
  skippedCount: number
}

export interface LocalNoteRecord {
  /** Immutable version digest (`documents.sha256`, 64-char lowercase hex). */
  sha256: string
  /** Always `"files"`. */
  source: "files"
  /** Canonical stable logical ID: `JSON.stringify([root, path])` (`fileSourceRef(root, path)`). */
  sourceRef: string
  /** Approved gate file-root ID (e.g. `"notes"`). */
  root: string
  /** Root-relative POSIX path (e.g. `"projects/q4-plan.md"`). */
  path: string
  /** Note MIME type (`"text/markdown"` or `"text/plain"`). */
  mime: NoteMime
  /** Display title (`document_text.title`, defaults to `path`). */
  title: string
  /** NFC, `\n`-normalized UTF-8 text (`document_text.body`). */
  body: string
  /** ISO 8601 UTC timestamp when this version was ingested (`documents.ingested_at`). */
  ingestedAt: string
  /** Assigned entity ID (`documents.entity_id`), if present. */
  entityId?: string
  /** Matching excerpt when returned from search. */
  excerpt?: LocalNoteExcerpt
}

export interface LocalNoteExcerpt {
  /** Immutable version digest (`documents.sha256`). */
  documentId: string
  /** Stable logical note ID (`fileSourceRef(root, path)`). */
  sourceRef: string
  root: string
  path: string
  title: string
  /** 0-based inclusive start offset in UTF-16 code units within `note.body`. */
  start: number
  /** 0-based exclusive end offset in UTF-16 code units within `note.body` (`0 <= start < end <= note.body.length`). */
  end: number
  /** 1-based inclusive start line number in `note.body.split("\n")`. */
  fromLine: number
  /** 1-based inclusive end line number in `note.body.split("\n")`. */
  toLine: number
  /** Verbatim slice of `note.body`; verified by `note.body.slice(start, end) === text`. */
  text: string
}

export type NotesAvailabilityStatus =
  "available" | "partial_sync" | "index_stale" | "source_missing"

export interface NotesCoverage {
  status: NotesAvailabilityStatus
  /** Configured note root IDs that were checked (default `["notes"]`). */
  searchedRoots: string[]
  /** Oldest `cursors.updated_at` across checked roots, or `null` if never synced. */
  lastSyncedAt: string | null
  /** Live note heads (`text/markdown`, `text/plain`) currently searchable in `searchedRoots`. */
  noteCount: number
  /** Total skipped items reported across checked roots' cursors. */
  skippedCount: number
}

export interface ReadNotesCoverageOptions {
  noteRoots?: readonly string[]
  maxStaleMs?: number
  approvedRoots?: readonly string[]
  now?: number
}

export interface SearchLocalNotesOptions {
  noteRoots?: readonly string[]
  limit?: number
}

function parseFileSourceRef(
  sourceRef: string
): { root: string; path: string } | null {
  try {
    const parsed: unknown = JSON.parse(sourceRef)
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { root: parsed[0], path: parsed[1] }
    }
  } catch {
    // malformed ref
  }
  return null
}

function lineStarts(body: string): number[] {
  const starts = [0]
  let idx = -1
  while ((idx = body.indexOf("\n", idx + 1)) !== -1) {
    starts.push(idx + 1)
  }
  return starts
}

function lineOf(lines: readonly number[], offset: number): number {
  let low = 0
  let high = lines.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (lines[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return low + 1
}

export function sliceNoteExcerpt(
  note: LocalNoteRecord,
  start: number,
  end: number
): LocalNoteExcerpt {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > note.body.length ||
    start >= end
  ) {
    throw new RangeError(
      `invalid excerpt offsets [${start}, ${end}) for body length ${note.body.length}`
    )
  }
  const lines = lineStarts(note.body)
  const fromLine = lineOf(lines, start)
  const toLine = lineOf(lines, end - 1)
  const text = note.body.slice(start, end)
  return {
    documentId: note.sha256,
    sourceRef: note.sourceRef,
    root: note.root,
    path: note.path,
    title: note.title,
    start,
    end,
    fromLine,
    toLine,
    text,
  }
}

export function readNotesCoverage(
  db: DatabaseSync,
  options: ReadNotesCoverageOptions = {}
): NotesCoverage {
  const noteRoots = options.noteRoots ?? DEFAULT_NOTE_ROOTS
  const maxStaleMs = options.maxStaleMs ?? 15 * 60_000
  const now = options.now ?? Date.now()
  const approvedRoots = options.approvedRoots
  const searchedRoots = [...noteRoots]

  // Read cursors for note roots
  const cursorRows = db
    .prepare(
      "SELECT stream, cursor, updated_at FROM cursors WHERE connector = 'files'"
    )
    .all() as { stream: unknown; cursor: unknown; updated_at: unknown }[]

  const cursorMap = new Map<
    string,
    { cursor: FileRootSyncCursor; updatedAt: string }
  >()
  for (const row of cursorRows) {
    const stream = String(row.stream)
    if (!searchedRoots.includes(stream)) continue
    let parsed: FileRootSyncCursor
    try {
      const obj: unknown = JSON.parse(String(row.cursor))
      if (typeof obj === "object" && obj !== null) {
        const record = obj as Record<string, unknown>
        parsed = {
          partial: Boolean(record["partial"]),
          indexedFiles: Number(record["indexedFiles"] ?? 0),
          noteCount: Number(record["noteCount"] ?? 0),
          skippedCount: Number(record["skippedCount"] ?? 0),
        }
      } else {
        parsed = {
          partial: true,
          indexedFiles: 0,
          noteCount: 0,
          skippedCount: 1,
        }
      }
    } catch {
      parsed = {
        partial: true,
        indexedFiles: 0,
        noteCount: 0,
        skippedCount: 1,
      }
    }
    cursorMap.set(stream, {
      cursor: parsed,
      updatedAt: String(row.updated_at),
    })
  }

  // Count live note heads in note roots
  const liveRows = db
    .prepare(
      `SELECT d.source_ref
       FROM documents d
       WHERE d.source = 'files'
         AND d.mime IN ('text/markdown', 'text/plain')
         AND ${LIVE_DOCUMENT_PREDICATE}`
    )
    .all() as { source_ref: unknown }[]

  let noteCount = 0
  for (const row of liveRows) {
    const loc = parseFileSourceRef(String(row.source_ref))
    if (loc !== null && searchedRoots.includes(loc.root)) {
      noteCount += 1
    }
  }

  let skippedCount = 0
  for (const [, item] of cursorMap) {
    skippedCount += item.cursor.skippedCount
  }

  // Compute lastSyncedAt: oldest updated_at across checked roots that have synced.
  // If any checked root never synced, lastSyncedAt is null.
  let lastSyncedAt: string | null = null
  const allSynced = searchedRoots.every((root) => cursorMap.has(root))
  if (allSynced && searchedRoots.length > 0) {
    let oldest = Number.POSITIVE_INFINITY
    let oldestStr = ""
    for (const root of searchedRoots) {
      const entry = cursorMap.get(root)
      if (entry) {
        const time = Date.parse(entry.updatedAt)
        if (time < oldest) {
          oldest = time
          oldestStr = entry.updatedAt
        }
      }
    }
    lastSyncedAt = oldestStr || null
  }

  // Determine status
  let status: NotesAvailabilityStatus

  const anyApproved =
    approvedRoots === undefined
      ? cursorMap.size > 0 || noteCount > 0
      : approvedRoots.some((r) => searchedRoots.includes(r))

  if (!anyApproved && cursorMap.size === 0 && noteCount === 0) {
    status = "source_missing"
  } else if (!anyApproved) {
    status = "source_missing"
  } else if (!allSynced) {
    status = "index_stale"
  } else {
    // Check if any root has stale cursor
    let hasStale = false
    let hasPartial = false
    for (const root of searchedRoots) {
      const entry = cursorMap.get(root)
      if (!entry) {
        hasStale = true
        break
      }
      const age = now - Date.parse(entry.updatedAt)
      if (age > maxStaleMs || Number.isNaN(age)) {
        hasStale = true
        break
      }
      if (entry.cursor.partial || entry.cursor.skippedCount > 0) {
        hasPartial = true
      }
    }

    if (hasStale) {
      status = "index_stale"
    } else if (hasPartial) {
      status = "partial_sync"
    } else {
      status = "available"
    }
  }

  return {
    status,
    searchedRoots,
    lastSyncedAt,
    noteCount,
    skippedCount,
  }
}

export function searchLocalNotes(
  db: DatabaseSync,
  query: string,
  options: SearchLocalNotesOptions = {}
): LocalNoteRecord[] {
  const noteRoots = options.noteRoots ?? DEFAULT_NOTE_ROOTS
  const limit = options.limit ?? 50
  const trimmed = query.trim()

  type NoteRow = {
    sha256: string
    source: string
    source_ref: string
    mime: string
    entity_id: string | null
    ingested_at: string
    title: string | null
    body: string
  }

  const rows = db
    .prepare(
      `SELECT d.sha256, d.source, d.source_ref, d.mime, d.entity_id, d.ingested_at,
              t.title, t.body
       FROM documents d
       JOIN document_text t ON t.sha256 = d.sha256
       WHERE d.source = 'files'
         AND d.mime IN ('text/markdown', 'text/plain')
         AND ${LIVE_DOCUMENT_PREDICATE}
       ORDER BY d.ingested_at DESC`
    )
    .all() as unknown as NoteRow[]

  const results: LocalNoteRecord[] = []
  const lowerQuery = trimmed.toLowerCase()

  for (const row of rows) {
    if (results.length >= limit) break
    const loc = parseFileSourceRef(row.source_ref)
    if (loc === null || !noteRoots.includes(loc.root)) continue

    const body = row.body
    const title = row.title ?? loc.path
    const lowerBody = body.toLowerCase()
    const lowerTitle = title.toLowerCase()

    let matchStart = -1
    let matchEnd = -1

    if (trimmed !== "") {
      const titleMatch = lowerTitle.includes(lowerQuery)
      const bodyIdx = lowerBody.indexOf(lowerQuery)

      if (bodyIdx !== -1) {
        matchStart = bodyIdx
        matchEnd = bodyIdx + trimmed.length
      } else if (!titleMatch) {
        // Check word tokens
        const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0)
        let tokenFound = false
        for (const token of tokens) {
          const tIdx = lowerBody.indexOf(token.toLowerCase())
          if (tIdx !== -1) {
            matchStart = tIdx
            matchEnd = tIdx + token.length
            tokenFound = true
            break
          }
        }
        if (
          !tokenFound &&
          !tokens.some((t) => lowerTitle.includes(t.toLowerCase()))
        ) {
          continue
        }
      }
    }

    const record: LocalNoteRecord = {
      sha256: row.sha256,
      source: "files",
      sourceRef: row.source_ref,
      root: loc.root,
      path: loc.path,
      mime: row.mime as NoteMime,
      title,
      body,
      ingestedAt: row.ingested_at,
      ...(row.entity_id ? { entityId: row.entity_id } : {}),
    }

    if (matchStart >= 0 && matchEnd > matchStart && matchEnd <= body.length) {
      record.excerpt = sliceNoteExcerpt(record, matchStart, matchEnd)
    }

    results.push(record)
  }

  return results
}
