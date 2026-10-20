import type { Intent } from "@eido/schemas"
import type { UpstreamRequest, UpstreamWriter } from "./executor"

// Gmail write adapters for the executor. They hold no token: the gate's write transport adds the
// compose client's (gmail.modify) credential. Mark read, label, archive and trash are all one
// users.messages.batchModify call that adds or removes labels; the executor lets these operations
// share that one pinned route. Draft and send are #248, reply and forward #249.
//
// Label ids are Gmail label ids (INBOX, UNREAD, Label_12, ...), as the intent carries them.

export const GMAIL_HOST = "gmail.googleapis.com"
export const GMAIL_CONNECTOR = "gmail"
export const GMAIL_BATCH_MODIFY_PATH = "/gmail/v1/users/me/messages/batchModify"
const BATCH_MODIFY_URL = `https://${GMAIL_HOST}${GMAIL_BATCH_MODIFY_PATH}`
const UNREAD = "UNREAD"
const INBOX = "INBOX"
const TRASH = "TRASH"
/** Labels a plain label change may not add: Trash needs the approval-tier trash intent. */
const LABELS_NOT_ADDED = new Set([TRASH, "SPAM"])

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A decoded batchModify body; `add` and `remove` are present exactly when the body has them. */
type BatchModify = { ids: string[]; add?: string[]; remove?: string[] }

/** Parses a batchModify request strictly: its exact URL and method, and only its three fields. */
function batchModify(
  request: Readonly<UpstreamRequest>,
  what: string
): BatchModify {
  const refuse = () => new Error(`not a Gmail ${what} request`)
  const { body } = request
  if (
    request.method !== "POST" ||
    request.url !== BATCH_MODIFY_URL ||
    !isRecord(body)
  )
    throw refuse()
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(body)
  )
  const allowed = new Set(["ids", "addLabelIds", "removeLabelIds"])
  if (Object.keys(fields).some((key) => !allowed.has(key))) throw refuse()
  const ids = fields["ids"]
  const added = fields["addLabelIds"]
  const removed = fields["removeLabelIds"]
  if (
    !isStringArray(ids) ||
    (added !== undefined && !isStringArray(added)) ||
    (removed !== undefined && !isStringArray(removed))
  )
    throw refuse()
  return {
    ids,
    ...(added === undefined ? {} : { add: added }),
    ...(removed === undefined ? {} : { remove: removed }),
  }
}

/** The connector field a decoded or inverse intent carries: the executor's, or the intent's. */
const on = (connector: string | undefined): { connector?: string } =>
  connector === undefined ? {} : { connector }
const sameConnector = (intent: Intent): { connector?: string } =>
  on("connector" in intent ? intent.connector : undefined)

/** Whether `labels` is exactly the one label `only`. */
const just = (labels: string[] | undefined, only: string): boolean =>
  labels !== undefined && labels.length === 1 && labels[0] === only

const addsForbidden = (labels: readonly string[] | undefined): boolean =>
  (labels ?? []).some((label) => LABELS_NOT_ADDED.has(label.toUpperCase()))

/** The read flag is Gmail's UNREAD label: marking read removes it, marking unread adds it. */
function markReadIntent(
  request: Readonly<UpstreamRequest>,
  connector?: string
): Intent {
  const parsed = batchModify(request, "mark read")
  if (parsed.add === undefined && just(parsed.remove, UNREAD))
    return {
      kind: "email.markRead",
      ...on(connector),
      args: { messageIds: parsed.ids, read: true },
    }
  if (parsed.remove === undefined && just(parsed.add, UNREAD))
    return {
      kind: "email.markRead",
      ...on(connector),
      args: { messageIds: parsed.ids, read: false },
    }
  throw new Error("not a Gmail mark read request")
}

export const gmailMarkReadWriter: UpstreamWriter = {
  connector: GMAIL_CONNECTOR,
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
      ...sameConnector(intent),
      args: { messageIds: affected, read: !read },
    }
  },
}

/** The prior-state report in a write result, or null when the transport gave none. */
function priorUnread(result: unknown): string[] | null {
  if (!isRecord(result)) return null
  const reported = result["previouslyUnread"]
  return isStringArray(reported) ? reported : null
}

/**
 * Each message's labels from before the write, as the transport reports them in
 * `{ priorLabels: { [messageId]: string[] } }`. Null when the report is missing, malformed or
 * lacks one of `ids`: undo is then unavailable rather than guessed.
 */
function priorLabels(
  result: unknown,
  ids: readonly string[]
): Map<string, Set<string>> | null {
  if (!isRecord(result)) return null
  const reported = result["priorLabels"]
  if (!isRecord(reported)) return null
  const prior = new Map<string, Set<string>>()
  for (const id of ids) {
    const labels = Object.hasOwn(reported, id) ? reported[id] : undefined
    if (!isStringArray(labels)) return null
    prior.set(id, new Set(labels))
  }
  return prior
}

function labelIntent(
  request: Readonly<UpstreamRequest>,
  connector?: string
): Intent {
  const parsed = batchModify(request, "label")
  if (addsForbidden(parsed.add)) throw new Error("not a Gmail label request")
  return {
    kind: "email.label",
    ...on(connector),
    args: {
      messageIds: parsed.ids,
      ...(parsed.add === undefined ? {} : { add: parsed.add }),
      ...(parsed.remove === undefined ? {} : { remove: parsed.remove }),
    },
  }
}

export const gmailLabelWriter: UpstreamWriter = {
  connector: GMAIL_CONNECTOR,
  kind: "email.label",
  buildRequest(intent) {
    if (intent.kind !== "email.label") throw new Error("wrong intent kind")
    const { messageIds, add, remove } = intent.args
    if (addsForbidden(add))
      throw new Error("a label change may not move mail to Trash or Spam")
    return {
      method: "POST",
      url: BATCH_MODIFY_URL,
      body: {
        ids: messageIds,
        ...(add === undefined ? {} : { addLabelIds: add }),
        ...(remove === undefined ? {} : { removeLabelIds: remove }),
      },
    }
  },
  intentFromRequest: labelIntent,
  // Undo takes off what the write actually added and puts back what it actually removed, from
  // each message's reported prior labels. One intent carries one change for all its messages, so
  // when the messages changed differently there is no single inverse and no undo.
  inverse(intent, result) {
    if (intent.kind !== "email.label") return null
    const { messageIds } = intent.args
    const add = intent.args.add ?? []
    const remove = intent.args.remove ?? []
    // Adding and removing one label in one call has no defined outcome to restore.
    if (add.some((label) => remove.includes(label))) return null
    const prior = priorLabels(result, messageIds)
    if (prior === null) return null
    const changes = new Map<
      string,
      { ids: string[]; added: string[]; removed: string[] }
    >()
    for (const id of messageIds) {
      const before = prior.get(id) ?? new Set<string>()
      const added = add.filter((label) => !before.has(label))
      const removed = remove.filter((label) => before.has(label))
      if (added.length === 0 && removed.length === 0) continue
      const key = JSON.stringify([added, removed])
      const group = changes.get(key) ?? { ids: [], added, removed }
      group.ids.push(id)
      changes.set(key, group)
    }
    const [only, ...others] = [...changes.values()]
    if (only === undefined || others.length > 0) return null
    // Restoring a removed Trash or Spam label would itself need approval.
    if (addsForbidden(only.removed)) return null
    return {
      kind: "email.label",
      ...sameConnector(intent),
      args: {
        messageIds: only.ids,
        ...(only.removed.length === 0 ? {} : { add: only.removed }),
        ...(only.added.length === 0 ? {} : { remove: only.added }),
      },
    }
  },
}

function archiveIntent(
  request: Readonly<UpstreamRequest>,
  connector?: string
): Intent {
  const parsed = batchModify(request, "archive")
  if (parsed.add !== undefined || !just(parsed.remove, INBOX))
    throw new Error("not a Gmail archive request")
  return {
    kind: "email.archive",
    ...on(connector),
    args: { messageIds: parsed.ids },
  }
}

/** Archiving is taking the INBOX label off. */
export const gmailArchiveWriter: UpstreamWriter = {
  connector: GMAIL_CONNECTOR,
  kind: "email.archive",
  buildRequest(intent) {
    if (intent.kind !== "email.archive") throw new Error("wrong intent kind")
    return {
      method: "POST",
      url: BATCH_MODIFY_URL,
      body: { ids: intent.args.messageIds, removeLabelIds: [INBOX] },
    }
  },
  intentFromRequest: archiveIntent,
  // Undo puts INBOX back on the messages that were in the inbox before, and only those.
  inverse(intent, result) {
    if (intent.kind !== "email.archive") return null
    const prior = priorLabels(result, intent.args.messageIds)
    if (prior === null) return null
    const inInbox = intent.args.messageIds.filter((id) =>
      prior.get(id)?.has(INBOX)
    )
    if (inInbox.length === 0) return null
    return {
      kind: "email.label",
      ...sameConnector(intent),
      args: { messageIds: inInbox, add: [INBOX] },
    }
  },
}

function trashIntent(
  request: Readonly<UpstreamRequest>,
  connector?: string
): Intent {
  const parsed = batchModify(request, "trash")
  if (parsed.remove !== undefined || !just(parsed.add, TRASH))
    throw new Error("not a Gmail trash request")
  return {
    kind: "email.trash",
    ...on(connector),
    args: { messageIds: parsed.ids },
  }
}

/**
 * Trash is adding the TRASH label, which Gmail empties on its own schedule; the gate never
 * removes mail itself. It is approval tier, so the executor records no inverse for it; taking a
 * message back out of Trash is #250.
 */
export const gmailTrashWriter: UpstreamWriter = {
  connector: GMAIL_CONNECTOR,
  kind: "email.trash",
  buildRequest(intent) {
    if (intent.kind !== "email.trash") throw new Error("wrong intent kind")
    return {
      method: "POST",
      url: BATCH_MODIFY_URL,
      body: { ids: intent.args.messageIds, addLabelIds: [TRASH] },
    }
  },
  intentFromRequest: trashIntent,
  inverse: () => null,
}

/** The Gmail writers the gate registers. */
export const GMAIL_WRITERS: readonly UpstreamWriter[] = [
  gmailMarkReadWriter,
  gmailLabelWriter,
  gmailArchiveWriter,
  gmailTrashWriter,
]
