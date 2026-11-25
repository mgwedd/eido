import type { GateEditRequest } from "@eido/schemas"

export type EditField = {
  key: string
  label: string
  /**
   * "list" is a comma separated list of strings, "block" is long text and "datetime" is an
   * RFC 3339 time shown as the device's local date and time.
   */
  type: "text" | "list" | "block" | "datetime"
  /** Fields that share a group sit together under one legend, for example "When". */
  group?: "When"
  initial: string
}

type FieldSpec = Omit<EditField, "initial">

const TO: FieldSpec = { key: "to", label: "To", type: "list" }
const MESSAGE: FieldSpec = { key: "body", label: "Message", type: "block" }
const CALENDAR_EVENT: readonly FieldSpec[] = [
  { key: "start", label: "Starts", type: "datetime", group: "When" },
  { key: "end", label: "Ends", type: "datetime", group: "When" },
  { key: "guests", label: "Attendees", type: "list" },
  { key: "description", label: "Notes", type: "block" },
]

/**
 * The designed edit forms: email send (To, Subject, Message) and calendar event (When,
 * Attendees, Notes). A reply has no subject of its own, so it offers To and Message. Every other
 * kind has no form, so its card has no Edit.
 */
const FORMS: Readonly<Record<string, readonly FieldSpec[]>> = {
  "email.send": [
    TO,
    { key: "subject", label: "Subject", type: "text" },
    MESSAGE,
  ],
  "email.reply": [TO, MESSAGE],
  "calendar.create": CALENDAR_EVENT,
  "calendar.edit": CALENDAR_EVENT,
}

/** True when the kind has a designed edit form, so its card offers Edit. */
export const hasEditForm = (kind: string): boolean => Object.hasOwn(FORMS, kind)

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

const pad = (value: number) => String(value).padStart(2, "0")

/** "2026-11-01T10:00:00-04:00" as the device's local "2026-11-01T10:00", the datetime-local format. */
export function toLocalInput(rfc3339: string): string | undefined {
  const date = new Date(rfc3339)
  if (Number.isNaN(date.getTime())) return undefined
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * A datetime-local value as RFC 3339 with the device's UTC offset on that date. A value that is
 * not a local date and time is returned as it is, so the gate refuses it instead of the form
 * inventing a time.
 */
export function fromLocalInput(local: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (match === null) return local
  const [, year, month, day, hour, minute] = match
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute)
  )
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? "-" : "+"
  const abs = Math.abs(offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function initialValue(spec: FieldSpec, value: unknown): string | undefined {
  if (spec.type === "list")
    return isStringList(value) ? value.join(", ") : undefined
  if (typeof value !== "string") return undefined
  return spec.type === "datetime" ? toLocalInput(value) : value
}

/**
 * The fields the owner can change before approving: the kind's designed fields that the payload
 * carries. Empty for a kind with no designed form or a payload that cannot be read.
 */
export function editableFields(payload: string): EditField[] {
  const parsed = parse(payload)
  if (parsed === undefined) return []
  return (FORMS[parsed.kind] ?? []).flatMap((spec) => {
    const initial = initialValue(spec, parsed.args[spec.key])
    return initial === undefined ? [] : [{ ...spec, initial }]
  })
}

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

function convert(field: EditField, text: string): unknown {
  if (field.type === "list") return splitList(text)
  if (field.type === "datetime") return fromLocalInput(text)
  return text
}

/**
 * The whole edited intent: the original kind and arguments with the changed values in place.
 * A field left as it was keeps its original value exactly, and arguments the form does not show
 * (ids, hashes, flags) are kept as they were.
 */
export function buildEditedIntent(
  payload: string,
  values: Readonly<Record<string, string>>
): GateEditRequest["intent"] | undefined {
  const parsed = parse(payload)
  if (parsed === undefined) return undefined
  const args: Record<string, unknown> = { ...parsed.args }
  for (const field of editableFields(payload)) {
    const text = values[field.key] ?? field.initial
    if (text !== field.initial) args[field.key] = convert(field, text)
  }
  return { kind: parsed.kind, args }
}

/** True when the field's value differs from what the card shows. */
export const isChanged = (
  field: EditField,
  values: Readonly<Record<string, string>>
) => (values[field.key] ?? field.initial) !== field.initial

/** True when any value differs from what the card shows. */
export function hasEdits(
  payload: string,
  values: Readonly<Record<string, string>>
): boolean {
  return editableFields(payload).some((field) => isChanged(field, values))
}

/** What the editor shows when the gate refused the edit or could not be reached. */
export type EditRefusal = {
  message: string
  /** The gate's own words, shown under the message. */
  detail?: string
  /** The fields and Sign and approve are disabled: no edit of this request can pass. */
  locked: boolean
  /** Offer Retry, which sends the same values again. */
  retry: boolean
}

/** The editor's alert for an edit the gate refused. */
export function editRefusal(failure: {
  code: string
  message: string
}): EditRefusal {
  switch (failure.code) {
    case "tier_changed":
      return {
        message:
          "This change moves the request to a different approval tier, so it was not saved. Reject it and ask again instead.",
        locked: false,
        retry: false,
      }
    case "invalid_request":
      return {
        message: "The gate could not accept these changes.",
        detail: failure.message,
        locked: false,
        retry: false,
      }
    case "forbidden":
      return {
        message: "You cannot edit this request.",
        locked: true,
        retry: false,
      }
    case "network":
      return {
        message: "The gate is not reachable. Your changes are kept.",
        locked: false,
        retry: true,
      }
    default:
      return { message: failure.message, locked: false, retry: false }
  }
}
