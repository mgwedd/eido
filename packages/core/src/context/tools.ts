import type { ToolDef } from "../inference/types"

/** The kinds of model request context is assembled for. */
export type TaskType = "ask" | "propose"

/** Context budget per task type, in estimated tokens. The values come from configuration. */
export type ContextBudgets = Record<TaskType, number>

export const TOOL_AREAS = ["email", "calendar", "files"] as const
export type ToolArea = (typeof TOOL_AREAS)[number]

const AREA_KEYWORDS: Record<ToolArea, RegExp> = {
  email:
    /\b(e-?mails?|mails?|messages?|inbox|repl(y|ies|ied)|forward(ed)?|archive[ds]?|drafts?|send|sent|labels?|unread|trash|threads?|attachments?)\b/i,
  calendar:
    /\b(calendars?|meetings?|events?|invites?|invitations?|appointments?|schedul(e|ed|ing)|reschedul(e|ed|ing)|reminders?|remind)\b/i,
  files: /\b(files?|folders?|documents?|docs?|renam(e|ed|ing)|pdfs?)\b/i,
}

/** The first segment of a verb name (`email.archive`) decides its area. */
const NAME_AREAS: Record<string, ToolArea> = {
  email: "email",
  calendar: "calendar",
  reminder: "calendar",
  file: "files",
}

/** A verb whose action is one of these only reads. */
const READ_ACTIONS = new Set([
  "search",
  "read",
  "get",
  "list",
  "find",
  "lookup",
])

// Trash restoration is a gate-derived operation: the gate supplies the message ids and prior
// labels from its authenticated trash receipt, so models never construct this intent directly.
const GATE_DERIVED_ACTIONS = new Set(["untrash"])

/** Money movement and permanent deletes are never offered, whatever the catalog holds. */
const FORBIDDEN_SEGMENT =
  /^(pay|payment|payments|transfer|wire|refund|purchase|buy|charge|withdraw|deposit|expunge|purge|destroy|wipe|erase|shred)$|permanent/i

function segments(tool: ToolDef): string[] {
  return tool.function.name.split(/[._-]/).filter((s) => s !== "")
}

function isForbidden(tool: ToolDef): boolean {
  return segments(tool).some((s) => FORBIDDEN_SEGMENT.test(s))
}

function isRead(tool: ToolDef): boolean {
  const action = segments(tool).at(-1)
  return action !== undefined && READ_ACTIONS.has(action.toLowerCase())
}

function areaOf(tool: ToolDef): ToolArea | undefined {
  const first = segments(tool)[0]
  return first === undefined ? undefined : NAME_AREAS[first.toLowerCase()]
}

/** The areas a request mentions, by keyword. Deterministic; no model call. */
export function detectAreas(text: string): ToolArea[] {
  return TOOL_AREAS.filter((area) => AREA_KEYWORDS[area].test(text))
}

/**
 * The tools offered for one request: every read verb, plus, for `propose`, the write verbs of the
 * areas the request mentions. `ask` only answers, so it never gets a write verb. An unrecognized
 * request gets read verbs only. Output is sorted by name, so the prompt prefix is stable.
 */
export function selectTools(
  request: { text: string; task: TaskType },
  catalog: ToolDef[]
): ToolDef[] {
  const areas = new Set(detectAreas(request.text))
  return catalog
    .filter((tool) => {
      if (isForbidden(tool)) return false
      if (GATE_DERIVED_ACTIONS.has(segments(tool).at(-1)?.toLowerCase() ?? ""))
        return false
      if (isRead(tool)) return true
      if (request.task !== "propose") return false
      const area = areaOf(tool)
      return area !== undefined && areas.has(area)
    })
    .sort((a, b) =>
      a.function.name < b.function.name
        ? -1
        : a.function.name > b.function.name
          ? 1
          : 0
    )
}
