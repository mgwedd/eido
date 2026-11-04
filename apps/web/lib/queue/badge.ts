/** What the shell knows about the pending count. */
export type QueueCount =
  | { status: "loading" }
  | { status: "ready"; count: number }
  | { status: "unreachable" }

const MAX_SHOWN = 99

/** The pill text: nothing at 0, "99+" past the cap. */
export function badgeText(count: number): string | null {
  if (count <= 0) return null
  return count > MAX_SHOWN ? `${MAX_SHOWN}+` : String(count)
}

/** The nav link's accessible name, or undefined when the label alone is the name. */
export function queueLinkName(
  label: string,
  queue: QueueCount
): string | undefined {
  if (queue.status !== "ready" || queue.count <= 0) return undefined
  return `${label}, ${queue.count} pending`
}
