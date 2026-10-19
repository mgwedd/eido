import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { soundex, tokenize, withinOneEdit } from "./text"

export interface SearchQuery {
  text: string
  after?: string
  before?: string
  source?: string
  limit?: number
  fuzzy?: boolean
}

export interface SearchHit {
  sha256: string
  source: string
  sourceRef: string
  title?: string
  occurredAt?: string
  score: number
  snippets: {
    fromLine: number
    lines: { n: number; text: string; hit: boolean }[]
  }[]
}

const DEFAULT_LIMIT = 20
const CONTEXT_LINES = 2
const FUZZY_MIN_LENGTH = 4

interface Plan {
  where: string
  params: SQLInputValue[]
  match: string | null
  hitTerms: Set<string>
}

const quote = (term: string): string => `"${term}"`

function expansions(db: DatabaseSync, term: string): string[] {
  const rows = db
    .prepare(
      "SELECT term FROM document_vocab WHERE length(term) BETWEEN ? AND ?"
    )
    .all(term.length - 1, term.length + 1)
  return rows
    .map((r) => String(r["term"]))
    .filter((t) => t !== term && withinOneEdit(term, t))
}

function hasExactTerm(db: DatabaseSync, term: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS x FROM document_vocab WHERE term = ? LIMIT 1")
      .get(term) !== undefined
  )
}

function hasName(db: DatabaseSync, key: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS x FROM name_keys WHERE phonetic_key = ? LIMIT 1")
      .get(key) !== undefined
  )
}

/** Turn user text into a quoted FTS5 MATCH string plus phonetic name clauses. Never concatenates raw input. */
function plan(db: DatabaseSync, q: SearchQuery): Plan | null {
  const terms = tokenize(q.text)
  if (terms.length === 0) return null
  const fuzzy = q.fuzzy ?? true
  const groups: string[] = []
  const conditions: string[] = []
  const params: SQLInputValue[] = []
  const hitTerms = new Set<string>()
  for (const term of terms) {
    const key = soundex(term)
    if (!hasExactTerm(db, term) && key !== null && hasName(db, key)) {
      conditions.push(
        "t.sha256 IN (SELECT sha256 FROM name_keys WHERE phonetic_key = ?)"
      )
      params.push(key)
      continue
    }
    const variants = [term]
    if (fuzzy && term.length >= FUZZY_MIN_LENGTH)
      variants.push(...expansions(db, term))
    for (const v of variants) hitTerms.add(v)
    groups.push(`(${variants.map(quote).join(" OR ")})`)
  }
  if (q.after !== undefined) {
    conditions.push("t.occurred_at >= ?")
    params.push(q.after)
  }
  if (q.before !== undefined) {
    conditions.push("t.occurred_at < ?")
    params.push(q.before)
  }
  if (q.source !== undefined) {
    conditions.push("d.source = ?")
    params.push(q.source)
  }
  return {
    where: conditions.map((c) => ` AND ${c}`).join(""),
    params,
    match: groups.length === 0 ? null : groups.join(" AND "),
    hitTerms,
  }
}

function snippets(body: string, hitTerms: Set<string>): SearchHit["snippets"] {
  const lines = body.split("\n")
  const windows: { start: number; end: number }[] = []
  lines.forEach((text, i) => {
    if (!tokenize(text).some((t) => hitTerms.has(t))) return
    const start = Math.max(0, i - CONTEXT_LINES)
    const end = Math.min(lines.length - 1, i + CONTEXT_LINES)
    const last = windows[windows.length - 1]
    if (last !== undefined && start <= last.end) last.end = end
    else windows.push({ start, end })
  })
  return windows.map(({ start, end }) => ({
    fromLine: start + 1,
    lines: lines.slice(start, end + 1).map((text, k) => ({
      n: start + k + 1,
      text,
      hit: tokenize(text).some((t) => hitTerms.has(t)),
    })),
  }))
}

const FROM_WITH_MATCH = `FROM document_fts JOIN document_text t ON t.rowid = document_fts.rowid
  JOIN documents d ON d.sha256 = t.sha256 WHERE document_fts MATCH ?`
const FROM_NO_MATCH = `FROM document_text t JOIN documents d ON d.sha256 = t.sha256 WHERE 1 = 1`

/** Ranked search: BM25 (title weighted over body), ties by newest then sha256. */
export function search(db: DatabaseSync, q: SearchQuery): SearchHit[] {
  const p = plan(db, q)
  if (p === null) return []
  const limit = q.limit ?? DEFAULT_LIMIT
  const select = `SELECT t.sha256, d.source, d.source_ref, t.title, t.occurred_at, t.body,`
  const sql =
    p.match === null
      ? `${select} 0 AS score ${FROM_NO_MATCH}${p.where} ORDER BY t.occurred_at DESC, t.sha256 LIMIT ?`
      : `${select} -bm25(document_fts, 5.0, 1.0) AS score ${FROM_WITH_MATCH}${p.where}
         ORDER BY score DESC, t.occurred_at DESC, t.sha256 LIMIT ?`
  const params =
    p.match === null ? [...p.params, limit] : [p.match, ...p.params, limit]
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => {
      const title = r["title"]
      const occurredAt = r["occurred_at"]
      return {
        sha256: String(r["sha256"]),
        source: String(r["source"]),
        sourceRef: String(r["source_ref"]),
        ...(typeof title === "string" ? { title } : {}),
        ...(typeof occurredAt === "string" ? { occurredAt } : {}),
        score: Number(r["score"]),
        snippets: snippets(String(r["body"]), p.hitTerms),
      }
    })
}

/** Number of documents matching the same filters, with no limit. */
export function countMatches(db: DatabaseSync, q: SearchQuery): number {
  const p = plan(db, q)
  if (p === null) return 0
  const sql =
    p.match === null
      ? `SELECT count(*) AS n ${FROM_NO_MATCH}${p.where}`
      : `SELECT count(*) AS n ${FROM_WITH_MATCH}${p.where}`
  const params = p.match === null ? p.params : [p.match, ...p.params]
  return Number(db.prepare(sql).get(...params)?.["n"] ?? 0)
}
