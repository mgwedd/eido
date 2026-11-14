import type { DatabaseSync } from "node:sqlite"
import { THINGS_CONNECTOR, THINGS_MIME } from "../connectors/things/sync"
import { fence, normalizeMaterial, toMaterial } from "../inference/fence"
import type { PromptPart } from "../inference/fence"

// The Todos block of a proposal pack: the open Things to-dos that share a word with the owner's
// request, so the model can name an existing to-do by its id (#744). Titles come from Things, so
// they are untrusted: the block is fenced like any other material.

/** At most this many to-dos are shown. */
export const MAX_TODO_LINES = 10
/** A title is cut at this many characters. */
export const MAX_TITLE_CHARS = 80

export interface TodoLine {
  id: string
  title: string
  status: "open"
  due?: string
}

export interface OpenTodos {
  /** The shown to-dos: best match first, newest first on ties. At most `MAX_TODO_LINES`. */
  todos: TodoLine[]
  /** How many open to-dos shared a word with the request, shown or not. */
  matched: number
}

// Words that carry no match: articles and prepositions, plus the words of a request about a
// to-do that every such request holds.
const STOP_WORDS = new Set(
  (
    "a an and are as at be but by for from has have i if in into is it its me my of on or our so " +
    "that the their then there these this those to up us was we were what when which who will with " +
    "you your please can could would should do does did not no yes all any some " +
    "todo todos to-do to-dos task tasks thing things item items list " +
    "cancel cancelled canceled cancelling complete completed completing finish finished done mark " +
    "schedule scheduled reschedule rescheduled postpone postponed defer deferred update updated " +
    "rename renamed edit edited change changed retitle drop add create new set put"
  ).split(" ")
)

function words(text: string): Set<string> {
  const found = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(found.filter((w) => !STOP_WORDS.has(w)))
}

const LIVE_OPEN_TODOS = `SELECT f.todo_id, t.title, f.due_date, t.occurred_at
  FROM document_heads h
  JOIN documents d ON d.sha256 = h.sha256
  JOIN things_todo_facts f ON f.sha256 = h.sha256
  JOIN document_text t ON t.sha256 = h.sha256
  WHERE h.source = ? AND d.mime = ? AND f.status = 'open'`

/**
 * The open to-dos of the document index whose title shares a word with the request (lowercase,
 * stop words removed), best match first, newest first on ties, at most ten, titles cut at 80
 * characters. A request that shares no word gets none. Completed and cancelled to-dos are never
 * listed, and neither is one whose id would not reach the model unchanged.
 */
export function listOpenTodos(db: DatabaseSync, request: string): OpenTodos {
  const wanted = words(request)
  const scored = db
    .prepare(LIVE_OPEN_TODOS)
    .all(THINGS_CONNECTOR, THINGS_MIME)
    .flatMap((row) => {
      const id = String(row["todo_id"])
      const title = typeof row["title"] === "string" ? row["title"] : ""
      if (normalizeMaterial(id) !== id) return []
      const shared = [...words(title)].filter((w) => wanted.has(w)).length
      if (shared === 0) return []
      const due = row["due_date"]
      return [
        {
          score: shared,
          at: typeof row["occurred_at"] === "string" ? row["occurred_at"] : "",
          line: {
            id,
            title: title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS),
            status: "open" as const,
            ...(typeof due === "string" && due !== "" ? { due } : {}),
          },
        },
      ]
    })
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) ||
      (a.line.id < b.line.id ? -1 : 1)
  )
  return {
    todos: scored.slice(0, MAX_TODO_LINES).map((s) => s.line),
    matched: scored.length,
  }
}

/**
 * The Todos block as prompt parts: a header, then one line per to-do, inside the pack's data
 * fence. No to-dos render nothing.
 */
export function renderTodosBlock(list: OpenTodos): PromptPart[] {
  if (list.todos.length === 0) return []
  const lines = list.todos.map(
    (t) =>
      `- id=${t.id} | ${t.title} | ${t.status}${t.due === undefined ? "" : ` | ${t.due}`}`
  )
  const header = `## Todos (open, ${String(list.todos.length)} of ${String(list.matched)} match)`
  return [
    "\n\nTodos you may refer to:\n",
    fence(toMaterial([header, ...lines].join("\n"), { source: "document" })),
  ]
}
