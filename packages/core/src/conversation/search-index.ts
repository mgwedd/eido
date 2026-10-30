import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import { soundex, tokenize, withinOneEdit } from "../index/text"
import type { SearchHit, SearchKind } from "./types"

// Full-text search over the raw transcript and the digests, as a rebuildable cache in its own
// SQLite file, separate from the authoritative tables. One FTS5 row per passage (a paragraph of
// a turn, or of a digest); a hit maps back to (conversation id, turn id). Ranked by BM25.
// Whole words, quoted phrases as consecutive words, trailing `*` for prefixes, plus typo and
// sound-alike matching for unquoted single terms.

/** Bump to make every existing index file rebuild from the raw tables. */
export const INDEX_VERSION = 1

const DEFAULT_LIMIT = 20
const FUZZY_MIN_LENGTH = 2
const SOUNDEX_MIN_LENGTH = 3

/** Open (or create) the search index file. It holds nothing that is not rebuilt from the raw tables. */
export function openConversationIndex(path: string): DatabaseSync {
  const index = new DatabaseSync(path)
  index.exec(
    "CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  )
  return index
}

const CREATE_PASSAGES = `CREATE VIRTUAL TABLE passages USING fts5(
  text,
  kind UNINDEXED, conversation_id UNINDEXED, turn_id UNINDEXED, seq UNINDEXED, part UNINDEXED
)`

/** The paragraphs of `text`, in order; a text with no blank line is one passage. */
export function splitPassages(text: string): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
  return parts.length > 0 ? parts : [text]
}

export interface IndexedTurn {
  conversationId: string
  turnId: string
  seq: number
  text: string
}

export function indexTurn(index: DatabaseSync, turn: IndexedTurn): void {
  const insert = index.prepare(
    "INSERT INTO passages (text, kind, conversation_id, turn_id, seq, part) VALUES (?, 'raw', ?, ?, ?, ?)"
  )
  splitPassages(turn.text).forEach((part, n) => {
    insert.run(part, turn.conversationId, turn.turnId, turn.seq, n)
  })
}

/** Replace the one digest entry of a conversation. */
export function replaceDigestPassages(
  index: DatabaseSync,
  conversationId: string,
  text: string
): void {
  index
    .prepare(
      "DELETE FROM passages WHERE kind = 'digest' AND conversation_id = ?"
    )
    .run(conversationId)
  const insert = index.prepare(
    "INSERT INTO passages (text, kind, conversation_id, turn_id, seq, part) VALUES (?, 'digest', ?, NULL, 0, ?)"
  )
  splitPassages(text).forEach((part, n) => {
    insert.run(part, conversationId, n)
  })
}

export interface RawRows {
  turns: IndexedTurn[]
  digests: { conversationId: string; text: string }[]
}

function indexIsCurrent(index: DatabaseSync, rows: RawRows): boolean {
  const version = index
    .prepare("SELECT value FROM index_meta WHERE key = 'version'")
    .get()?.["value"]
  if (version !== String(INDEX_VERSION)) return false
  const count = (kind: SearchKind): number =>
    Number(
      index
        .prepare(
          "SELECT count(DISTINCT coalesce(turn_id, conversation_id)) AS n FROM passages WHERE kind = ?"
        )
        .get(kind)?.["n"] ?? 0
    )
  return (
    count("raw") === rows.turns.length &&
    count("digest") === rows.digests.length
  )
}

/**
 * Bring the index in line with the raw rows: rebuild it from them when it is new, was written
 * by another index version, or does not cover every turn and digest.
 */
export function ensureIndex(index: DatabaseSync, rows: RawRows): void {
  const hasTable =
    index
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'passages'")
      .get() !== undefined
  if (hasTable && indexIsCurrent(index, rows)) return
  index.exec("BEGIN")
  try {
    index.exec("DROP TABLE IF EXISTS passages")
    index.exec(CREATE_PASSAGES)
    for (const turn of rows.turns) indexTurn(index, turn)
    for (const digest of rows.digests) {
      replaceDigestPassages(index, digest.conversationId, digest.text)
    }
    index
      .prepare(
        "INSERT INTO index_meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
      )
      .run(String(INDEX_VERSION))
    index.exec("COMMIT")
  } catch (error) {
    index.exec("ROLLBACK")
    throw error
  }
}

/**
 * A quoted FTS5 MATCH string from user text, or null when it has no searchable word. Bare words
 * and quoted phrases are ANDed; a trailing `*` makes the last word a prefix. Raw input never
 * reaches the MATCH string unquoted.
 */
export function buildMatch(query: string): string | null {
  const clauses: string[] = []
  for (const m of query.matchAll(/"([^"]*)"|([^\s"]+)/g)) {
    const quoted = m[1] !== undefined
    const raw = m[1] ?? m[2] ?? ""
    const words = tokenize(raw)
    if (words.length === 0) continue
    const prefix = !quoted && raw.endsWith("*")
    clauses.push(`"${words.join(" ")}"${prefix ? " *" : ""}`)
  }
  return clauses.length === 0 ? null : clauses.join(" AND ")
}

/** Expand unquoted single terms from the words actually present in the index. */
function buildFuzzyMatch(index: DatabaseSync, query: string): string | null {
  const vocabulary = new Set<string>()
  for (const row of index.prepare("SELECT text FROM passages").all()) {
    for (const word of tokenize(String(row["text"]))) vocabulary.add(word)
  }
  const clauses: string[] = []
  for (const m of query.matchAll(/"([^"]*)"|([^\s"]+)/g)) {
    const quoted = m[1] !== undefined
    const raw = m[1] ?? m[2] ?? ""
    const words = tokenize(raw)
    if (words.length === 0) continue
    const prefix = !quoted && raw.endsWith("*")
    const exact = `"${words.join(" ")}"${prefix ? " *" : ""}`
    const term = words.at(0)
    if (
      quoted ||
      prefix ||
      words.length !== 1 ||
      term === undefined ||
      term.length < FUZZY_MIN_LENGTH
    ) {
      clauses.push(exact)
      continue
    }

    const variants = new Set([term])
    for (const candidate of vocabulary) {
      if (
        candidate !== term &&
        Math.abs(candidate.length - term.length) <= 1 &&
        withinOneEdit(term, candidate)
      ) {
        variants.add(candidate)
      }
    }
    if (term.length >= SOUNDEX_MIN_LENGTH) {
      const key = soundex(term)
      if (key !== null && !vocabulary.has(term)) {
        for (const candidate of vocabulary) {
          if (candidate !== term && soundex(candidate) === key)
            variants.add(candidate)
        }
      }
    }
    clauses.push(
      variants.size === 1
        ? exact
        : `(${[...variants].map((variant) => `"${variant}"`).join(" OR ")})`
    )
  }
  return clauses.length === 0 ? null : clauses.join(" AND ")
}

function searchMatch(
  index: DatabaseSync,
  match: string,
  opts: { limit?: number; kind?: SearchKind | "any" }
): SearchHit[] {
  const kind = opts.kind ?? "any"
  const params: SQLInputValue[] = [match]
  let where = "passages MATCH ?"
  if (kind !== "any") {
    where += " AND kind = ?"
    params.push(kind)
  }
  params.push(opts.limit ?? DEFAULT_LIMIT)
  // Ties break on stable columns so a rebuilt index answers in the same order.
  const rows = index
    .prepare(
      `SELECT kind, conversation_id, turn_id,
              snippet(passages, 0, '[', ']', '...', 16) AS snippet,
              -bm25(passages) AS score
       FROM passages WHERE ${where}
       ORDER BY score DESC, kind, conversation_id, seq, part LIMIT ?`
    )
    .all(...params)
  return rows.map((r) => {
    const turnId = r["turn_id"]
    return {
      conversationId: String(r["conversation_id"]),
      ...(typeof turnId === "string" ? { turnId } : {}),
      kind: r["kind"] === "digest" ? "digest" : "raw",
      snippet: String(r["snippet"]),
      score: Number(r["score"]),
    }
  })
}

export function searchIndex(
  index: DatabaseSync,
  query: string,
  opts: { limit?: number; kind?: SearchKind | "any" } = {}
): SearchHit[] {
  const match = buildMatch(query)
  if (match === null) return []
  const exactHits = searchMatch(index, match, opts)
  const fuzzyMatch = buildFuzzyMatch(index, query)
  if (fuzzyMatch === null || fuzzyMatch === match) return exactHits
  const fuzzyHits = searchMatch(index, fuzzyMatch, opts)
  const seen = new Set(
    exactHits.map(
      (hit) => `${hit.kind}:${hit.conversationId}:${hit.turnId ?? ""}`
    )
  )
  const additions = fuzzyHits.filter((hit) => {
    const key = `${hit.kind}:${hit.conversationId}:${hit.turnId ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [...exactHits, ...additions].slice(0, opts.limit ?? DEFAULT_LIMIT)
}
