import type { GatePendingIntentList } from "@eido/schemas"

export type PendingIntent = GatePendingIntentList["intents"][number]

/** The Needs you card shows at most this many intents. */
export const NEEDS_YOU_LIMIT = 5

const KIND_LABELS: Readonly<
  Record<string, { source: string; action: string }>
> = {
  "email.draft": { source: "Email", action: "Save draft" },
  "email.label": { source: "Email", action: "Label" },
  "email.archive": { source: "Email", action: "Archive" },
  "email.markRead": { source: "Email", action: "Mark read" },
  "email.send": { source: "Email", action: "Send" },
  "email.reply": { source: "Email", action: "Reply" },
  "email.forward": { source: "Email", action: "Forward" },
  "email.trash": { source: "Email", action: "Move to trash" },
  "calendar.create": { source: "Calendar", action: "Send invitation" },
  "calendar.edit": { source: "Calendar", action: "Change event" },
  "calendar.delete": { source: "Calendar", action: "Cancel event" },
  "reminder.create": { source: "Reminders", action: "Create reminder" },
  "file.create": { source: "Files", action: "Create file" },
  "file.rename": { source: "Files", action: "Rename file" },
  "file.move": { source: "Files", action: "Move file" },
  "file.delete": { source: "Files", action: "Move file to trash" },
}

/**
 * "Email · Send". The pending list carries the intent kind but no payload, so the label
 * comes from the kind alone; an unknown kind is shown as the gate sent it.
 */
export function describeKind(kind: string): string {
  const label = KIND_LABELS[kind]
  return label ? `${label.source} · ${label.action}` : kind
}

/** Oldest first, capped at the card's limit. */
export function selectNeedsYou(
  intents: readonly PendingIntent[]
): PendingIntent[] {
  return [...intents]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, NEEDS_YOU_LIMIT)
}

/** "Sunday, October 18" in the viewer's locale and time zone. */
export function formatToday(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now)
}

/** "2 items need you", "1 item needs you" or "Nothing needs you". */
export function needsYouSummary(count: number): string {
  if (count === 0) return "Nothing needs you"
  return count === 1 ? "1 item needs you" : `${count} items need you`
}
