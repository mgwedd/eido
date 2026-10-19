import type { Intent } from "@eido/schemas"
import type { UpstreamRequest, UpstreamWriter } from "./executor"

// Gmail write adapters for the executor. They hold no token: the gate's write transport adds the
// compose client's (gmail.modify) credential. Only mark read is here so far; the other Gmail write
// kinds need a gate change first (see the executor's one-route-per-operation rule).

export const GMAIL_HOST = "gmail.googleapis.com"
export const GMAIL_BATCH_MODIFY_PATH = "/gmail/v1/users/me/messages/batchModify"
const BATCH_MODIFY_URL = `https://${GMAIL_HOST}${GMAIL_BATCH_MODIFY_PATH}`
const UNREAD = "UNREAD"

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

/** The read flag is Gmail's UNREAD label: marking read removes it, marking unread adds it. */
function markReadIntent(request: Readonly<UpstreamRequest>): Intent {
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
    return { kind: "email.markRead", args: { messageIds: ids, read: true } }
  if (
    keys.join() === "addLabelIds,ids" &&
    isStringArray(added) &&
    added.join() === UNREAD
  )
    return { kind: "email.markRead", args: { messageIds: ids, read: false } }
  throw new Error("not a Gmail mark read request")
}

export const gmailMarkReadWriter: UpstreamWriter = {
  kind: "email.markRead",
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
  // Undo flips the flag back: a message marked read becomes unread again, and the reverse.
  inverse(intent) {
    if (intent.kind !== "email.markRead") return null
    return {
      kind: "email.markRead",
      args: { messageIds: intent.args.messageIds, read: !intent.args.read },
    }
  },
}
