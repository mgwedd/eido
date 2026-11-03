import type { GateEditRequest } from "@eido/schemas"
import { LABELS } from "@/lib/queue/card"

export type EditField = {
  key: string
  label: string
  /** "list" is a comma separated list of strings; "block" is long text. */
  type: "text" | "list" | "block"
  initial: string
}

const BLOCK_KEYS = new Set(["body", "content", "description", "notes", "note"])

/** Identifiers and hashes are not text the user writes; the edit keeps them as they are. */
const FIXED_KEYS = new Set([
  "messageSha256",
  "messageId",
  "messageIds",
  "eventUid",
])

type Parsed = { kind: string; args: Record<string, unknown> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

function parse(payload: string): Parsed | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed["kind"] !== "string") return undefined
  const args = parsed["args"]
  return isRecord(args) ? { kind: parsed["kind"], args } : undefined
}

/** The payload's text and list arguments, which the user can change before approving. */
export function editableFields(payload: string): EditField[] {
  const parsed = parse(payload)
  if (parsed === undefined) return []
  return Object.entries(parsed.args).flatMap<EditField>(([key, value]) => {
    if (FIXED_KEYS.has(key)) return []
    const label = LABELS[key] ?? key
    if (typeof value === "string")
      return [
        {
          key,
          label,
          type: BLOCK_KEYS.has(key) ? "block" : "text",
          initial: value,
        },
      ]
    if (isStringList(value))
      return [{ key, label, type: "list", initial: value.join(", ") }]
    return []
  })
}

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

/**
 * The whole edited intent: the original kind and arguments with the edited values in place.
 * Arguments the form does not offer (ids, hashes, numbers) are kept as they were.
 */
export function buildEditedIntent(
  payload: string,
  values: Readonly<Record<string, string>>
): GateEditRequest["intent"] | undefined {
  const parsed = parse(payload)
  if (parsed === undefined) return undefined
  const fields = editableFields(payload)
  const args: Record<string, unknown> = { ...parsed.args }
  for (const field of fields) {
    const text = values[field.key] ?? field.initial
    args[field.key] = field.type === "list" ? splitList(text) : text
  }
  return { kind: parsed.kind, args }
}

/** True when any value differs from what the card shows. */
export function hasEdits(
  payload: string,
  values: Readonly<Record<string, string>>
): boolean {
  return editableFields(payload).some(
    (field) => (values[field.key] ?? field.initial) !== field.initial
  )
}

/** The card's message for an edit the gate refused. */
export function editRefusalMessage(failure: {
  code: string
  message: string
}): string {
  switch (failure.code) {
    case "tier_changed":
      return "Edit refused. This change moves the intent to a different tier. Reject it and ask again instead."
    case "forbidden":
      return "Edit refused. Policy forbids the edited intent."
    case "invalid_request":
      return "Edit refused. The edited values are not a valid intent."
    default:
      return failure.message
  }
}
