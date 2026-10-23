import type { SearchPlan } from "./types"

const DATE =
  "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})?)?$"
const DATE_RE = new RegExp(DATE)
const WANTS = ["count", "find", "summarize"] as const

/** JSON-schema mode turns this into a grammar, so the model can only answer with a plan. */
export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["terms", "wants"],
  properties: {
    terms: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 64 },
    },
    after: { type: "string", pattern: DATE },
    before: { type: "string", pattern: DATE },
    wants: { type: "string", enum: [...WANTS] },
  },
} as const satisfies Record<string, unknown>

/** Stable across requests, so the server's prompt cache keeps it. */
export const PLAN_SYSTEM = [
  "You turn the owner's question about their messages into a search plan.",
  "Reply with JSON only: terms (search words), optional after and before (ISO dates; after is inclusive, before is exclusive), and wants.",
  'wants is "count" when the question asks how many, "find" when it asks for specific messages or facts, "summarize" when it asks for an overview.',
  "Use the words most likely to appear in the messages. Leave out filler words and dates.",
].join("\n")

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const isWant = (value: unknown): value is SearchPlan["wants"] =>
  WANTS.some((w) => w === value)

function optionalDate(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === "string" && DATE_RE.test(value) ? value : null
}

/** The model's plan text, checked field by field. Null when it is not a usable plan. */
export function parsePlan(text: string): SearchPlan | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const { terms, wants } = value
  if (!Array.isArray(terms) || !isWant(wants)) return null
  const cleaned = terms
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t !== "")
  if (cleaned.length === 0 || cleaned.length !== terms.length) return null
  const after = optionalDate(value["after"])
  const before = optionalDate(value["before"])
  if (after === null || before === null) return null
  return {
    terms: cleaned,
    wants,
    ...(after === undefined ? {} : { after }),
    ...(before === undefined ? {} : { before }),
  }
}
