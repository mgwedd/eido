import type { GateIntentHistory, GateRejectReason } from "@eido/schemas"
import { describeKind } from "@/lib/today"

export type CardField = {
  label: string
  value: string
  /** A long text block (an email body) shown apart from the short fields. */
  block?: boolean
}

export type CardView = {
  /** "Email · Send": the connector and the action. */
  heading: string
  title: string
  fields: CardField[]
}

type Args = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The payload's `args`, or undefined when the text is not an intent payload. */
function parseArgs(payload: string): Args | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  return isRecord(parsed["args"]) ? parsed["args"] : {}
}

/** Text from an unknown payload value, never markup: arrays are comma joined. */
function plain(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  if (Array.isArray(value)) return value.map(plain).join(", ")
  return JSON.stringify(value)
}

const LABELS: Readonly<Record<string, string>> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  body: "Message",
  note: "Note",
  start: "Starts",
  end: "Ends",
  allDay: "All day",
  entity: "Calendar",
  category: "Category",
  location: "Where",
  description: "Notes",
  guests: "Guests",
  title: "Title",
  due: "Due",
  notes: "Notes",
  list: "List",
  root: "Folder",
  path: "Path",
  toPath: "Move to",
  newName: "New name",
  content: "Content",
  messageIds: "Messages",
  messageId: "Message",
  add: "Add labels",
  remove: "Remove labels",
  read: "Mark as read",
  replyAll: "Reply to all",
  eventUid: "Event",
}

/** Fields never shown: a hash of the target message says nothing to the reader. */
const HIDDEN = new Set(["messageSha256"])

const BLOCK_FIELDS = new Set([
  "body",
  "content",
  "description",
  "notes",
  "note",
])

/** Shown first, in this order; every other field follows in payload order. */
const ORDER = [
  "to",
  "cc",
  "bcc",
  "subject",
  "title",
  "start",
  "end",
  "allDay",
  "entity",
  "location",
  "guests",
]

function titleFor(kind: string, args: Args): string {
  const subject = typeof args["subject"] === "string" ? args["subject"] : ""
  const title = typeof args["title"] === "string" ? args["title"] : ""
  const to = plain(args["to"] ?? "")
  switch (kind) {
    case "email.send":
    case "email.draft":
      return to ? `Email to ${to}` : "Email"
    case "email.reply":
      return to ? `Reply to ${to}` : "Reply"
    case "email.forward":
      return to ? `Forward to ${to}` : "Forward"
    case "email.label":
    case "email.archive":
    case "email.markRead":
    case "email.trash":
      return `${describeKind(kind).split(" · ")[1] ?? kind} ${plain(args["messageIds"] ?? "").split(", ").length} message(s)`
    case "calendar.create":
      return title ? `Create event: ${title}` : "Create event"
    case "calendar.edit":
      return title ? `Change event: ${title}` : "Change event"
    case "calendar.delete":
      return "Cancel event"
    case "reminder.create":
      return title ? `Create reminder: ${title}` : "Create reminder"
    default:
      return subject || describeKind(kind)
  }
}

/**
 * The card as a pure function of the stored payload text: a fixed title per kind and one
 * labelled field per payload argument. Nothing is interpreted as markup and no argument
 * is hidden (apart from message hashes), so what is shown is what is signed.
 * Returns undefined when the payload cannot be read, so the card has no Approve.
 */
export function buildCard(kind: string, payload: string): CardView | undefined {
  const args = parseArgs(payload)
  if (args === undefined) return undefined
  const keys = Object.keys(args).filter((key) => !HIDDEN.has(key))
  keys.sort((a, b) => {
    const ia = ORDER.indexOf(a)
    const ib = ORDER.indexOf(b)
    return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib)
  })
  return {
    heading: describeKind(kind),
    title: titleFor(kind, args),
    fields: keys.map((key) => ({
      label: LABELS[key] ?? key,
      value: plain(args[key]),
      ...(BLOCK_FIELDS.has(key) ? { block: true } : {}),
    })),
  }
}

/** "Waiting" starts at the first pending entry, or the intent's creation time. */
export function waitingSince(
  history: GateIntentHistory | undefined,
  createdAt: string
): string {
  const pending = history?.entries.find((entry) => entry.to === "pending")
  return pending?.at ?? createdAt
}

export type HistoryRow = {
  key: string
  time: string
  iso: string
  change: string
  actor: string
  reason?: string
}

const ACTORS: Readonly<Record<string, string>> = {
  "data-plane": "Agent",
  policy: "Policy",
  approver: "You",
  executor: "Gate",
  system: "System",
}

/** Oldest first, as the gate sends it. An undo is an executed to executed entry. */
export function historyRows(
  history: GateIntentHistory,
  formatTime: (iso: string) => string
): HistoryRow[] {
  return history.entries.map((entry, index) => {
    const undo = entry.from === "executed" && entry.to === "executed"
    return {
      key: `${entry.at}-${index}`,
      time: formatTime(entry.at),
      iso: entry.at,
      change: undo
        ? "undone"
        : entry.from === null
          ? entry.to
          : `${entry.from} to ${entry.to}`,
      actor: ACTORS[entry.actor] ?? entry.actor,
      ...(entry.reason ? { reason: entry.reason } : {}),
    }
  })
}

export const REJECT_REASONS: readonly {
  code: GateRejectReason
  label: string
}[] = [
  { code: "wrong_recipient", label: "Wrong recipient" },
  { code: "wrong_content", label: "Wrong content" },
  { code: "wrong_tone", label: "Wrong tone" },
  { code: "wrong_time", label: "Wrong time" },
  { code: "not_needed", label: "Not needed" },
  { code: "other", label: "Other" },
]

/** The swipe commits past this many pixels, and labels show past the lower one. */
export const SWIPE_COMMIT_PX = 110
export const SWIPE_LABEL_PX = 40

export type SwipeOutcome = "approve" | "reject" | "none"

export function swipeOutcome(dx: number): SwipeOutcome {
  if (dx >= SWIPE_COMMIT_PX) return "approve"
  if (dx <= -SWIPE_COMMIT_PX) return "reject"
  return "none"
}

export function swipeLabel(dx: number): "Approve" | "Reject" | null {
  if (dx >= SWIPE_LABEL_PX) return "Approve"
  if (dx <= -SWIPE_LABEL_PX) return "Reject"
  return null
}
