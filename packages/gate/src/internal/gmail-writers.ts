import type { Intent } from "@eido/schemas"
import type { UpstreamRequest, UpstreamWriter } from "./executor"

// Gmail write adapters for the executor. They hold no token: the gate's write transport adds the
// compose client's (gmail.modify) credential. Only mark read is here so far; the other Gmail write
// kinds need a gate change first (see the executor's one-route-per-operation rule).

export const GMAIL_HOST = "gmail.googleapis.com"
export const GMAIL_CONNECTOR = "gmail"
export const GMAIL_BATCH_MODIFY_PATH = "/gmail/v1/users/me/messages/batchModify"
const BATCH_MODIFY_URL = `https://${GMAIL_HOST}${GMAIL_BATCH_MODIFY_PATH}`
const UNREAD = "UNREAD"

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

/** The read flag is Gmail's UNREAD label: marking read removes it, marking unread adds it. */
function markReadIntent(
  request: Readonly<UpstreamRequest>,
  connector?: string
): Intent {
  const { body } = request
  if (
    request.method !== "POST" ||
    request.url !== BATCH_MODIFY_URL ||
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  )
    throw new Error("not a Gmail mark read request")
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(body)
  )
  const keys = Object.keys(fields).sort()
  const ids = fields["ids"]
  const added = fields["addLabelIds"]
  const removed = fields["removeLabelIds"]
  if (!isStringArray(ids)) throw new Error("not a Gmail mark read request")
  if (
    keys.join() === "ids,removeLabelIds" &&
    isStringArray(removed) &&
    removed.join() === UNREAD
  )
    return {
      kind: "email.markRead",
      ...(connector === undefined ? {} : { connector }),
      args: { messageIds: ids, read: true },
    }
  if (
    keys.join() === "addLabelIds,ids" &&
    isStringArray(added) &&
    added.join() === UNREAD
  )
    return {
      kind: "email.markRead",
      ...(connector === undefined ? {} : { connector }),
      args: { messageIds: ids, read: false },
    }
  throw new Error("not a Gmail mark read request")
}

export const gmailMarkReadWriter: UpstreamWriter = {
  kind: "email.markRead",
  connector: GMAIL_CONNECTOR,
  buildRequest(intent) {
    if (intent.kind !== "email.markRead") throw new Error("wrong intent kind")
    const { messageIds, read } = intent.args
    return {
      method: "POST",
      url: BATCH_MODIFY_URL,
      body: read
        ? { ids: messageIds, removeLabelIds: [UNREAD] }
        : { ids: messageIds, addLabelIds: [UNREAD] },
    }
  },
  intentFromRequest: markReadIntent,
  // Undo restores each message's own prior state, not the intent's flag for all of them. batchModify
  // answers with an empty body, so the write transport reports the prior state in the result as
  // `{ previouslyUnread: string[] }` (the intent's ids that carried UNREAD before the call). Without
  // that report the prior state is unknown, and the result is no undo rather than a guess.
  inverse(intent, result) {
    if (intent.kind !== "email.markRead") return null
    const previouslyUnread = priorUnread(result)
    if (previouslyUnread === null) return null
    const { messageIds, read } = intent.args
    // Marked read: undo re-marks unread only what was unread. Marked unread: undo marks read only
    // what was read before.
    const changed = new Set(previouslyUnread)
    const affected = messageIds.filter((id) => changed.has(id) === read)
    if (affected.length === 0) return null
    return {
      kind: "email.markRead",
      ...("connector" in intent ? { connector: intent.connector } : {}),
      args: { messageIds: affected, read: !read },
    }
  },
}

/** The prior-state report in a write result, or null when the transport gave none. */
function priorUnread(result: unknown): string[] | null {
  if (typeof result !== "object" || result === null) return null
  const reported: unknown = Object.fromEntries(Object.entries(result))[
    "previouslyUnread"
  ]
  return isStringArray(reported) ? reported : null
}
