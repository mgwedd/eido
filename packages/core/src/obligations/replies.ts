import type { DatabaseSync } from "node:sqlite"
import { insertObligation } from "../ledger/store"
import type { ObligationDirection } from "../ledger/types"

export type ReplyCandidate = {
  threadId: string
  direction: ObligationDirection
  anchorMessageId: string
  party: string
  entityId: string
  dueAt: string
  source: { docSha256: string; messageId: string; start: number; end: number }
}

export type RepliesConfig = {
  db: DatabaseSync
  me: readonly string[]
  ownerEntityId?: string
  repliesOwed: { afterDays: number }
  waitingOn: { afterDays: number }
  excludeSenders: readonly string[]
}

type Row = Record<string, unknown>
type Address = { role: string; address: string }
type Message = {
  sha: string
  entity: string
  title: string
  body: string
  occurred: number
  messageId: string
  inReplyTo: string | null
  threadId: string
  references: string[]
  addresses: Address[]
  listUnsubscribe: boolean | null
  autoSubmitted: string | null
  precedence: string | null
}
const string = (row: Row, key: string): string | null =>
  typeof row[key] === "string" ? row[key] : null
const number = (row: Row, key: string): number | null =>
  typeof row[key] === "number" ? row[key] : null
const lower = (address: string): string => address.trim().toLowerCase()
const dayMs = 86_400_000
const askPattern =
  /\?|\b(let me know|please confirm|please send|could you|can you|would you|please let me know|when can you|what do you think)\b/i

function getMessages(cfg: RepliesConfig): Message[] {
  const rows = cfg.db
    .prepare(
      `
    SELECT d.sha256, d.entity_id, t.title, t.body, t.occurred_at,
      t.message_id, t.in_reply_to, t.thread_id, t.references_json,
      f.list_unsubscribe, f.auto_submitted, f.precedence
    FROM documents d JOIN document_text t ON t.sha256 = d.sha256
    LEFT JOIN mail_message_facts f ON f.sha256 = d.sha256
    WHERE d.mime = 'message/rfc822' AND t.message_id IS NOT NULL AND t.thread_id IS NOT NULL
      AND t.occurred_at IS NOT NULL
  `
    )
    .all()
  const messages: Message[] = []
  for (const raw of rows) {
    const row: Row = raw
    const sha = string(row, "sha256")
    const entity = string(row, "entity_id") ?? cfg.ownerEntityId ?? null
    const occurredText = string(row, "occurred_at")
    const occurred =
      occurredText === null ? Number.NaN : Date.parse(occurredText)
    const messageId = string(row, "message_id")
    const threadId = string(row, "thread_id")
    const body = string(row, "body")
    if (
      sha === null ||
      entity === null ||
      !Number.isFinite(occurred) ||
      messageId === null ||
      threadId === null ||
      body === null
    )
      continue
    const refsRaw = string(row, "references_json")
    let references: string[] = []
    if (refsRaw !== null) {
      try {
        const parsed: unknown = JSON.parse(refsRaw)
        if (
          Array.isArray(parsed) &&
          parsed.every((item) => typeof item === "string")
        )
          references = parsed
      } catch {
        references = []
      }
    }
    const addressRows = cfg.db
      .prepare(
        "SELECT role, address FROM mail_addresses WHERE sha256 = ? ORDER BY role, position"
      )
      .all(sha)
    const addresses = addressRows.flatMap((addressRow): Address[] => {
      const role = string(addressRow, "role")
      const address = string(addressRow, "address")
      return role === null || address === null ? [] : [{ role, address }]
    })
    const flag = number(row, "list_unsubscribe")
    messages.push({
      sha,
      entity,
      title: string(row, "title") ?? "",
      body,
      occurred,
      messageId,
      threadId,
      references,
      addresses,
      inReplyTo: string(row, "in_reply_to"),
      listUnsubscribe: flag === null ? null : flag === 1,
      autoSubmitted: string(row, "auto_submitted"),
      precedence: string(row, "precedence"),
    })
  }
  return messages
}

function groupedMessages(messages: readonly Message[]): Map<string, Message[]> {
  const parent = new Map<string, string>()
  const key = (entity: string, messageId: string): string =>
    `${entity}\u0000${messageId}`
  const find = (node: string): string => {
    const current = parent.get(node)
    if (current === undefined) {
      parent.set(node, node)
      return node
    }
    if (current === node) return node
    const root = find(current)
    parent.set(node, root)
    return root
  }
  const join = (left: string, right: string): void => {
    const a = find(left)
    const b = find(right)
    if (a === b) return
    const first = a < b ? a : b
    const second = a < b ? b : a
    parent.set(second, first)
  }
  for (const message of messages) {
    const own = key(message.entity, message.messageId)
    find(own)
    for (const reference of message.references)
      join(own, key(message.entity, reference))
    if (message.inReplyTo !== null)
      join(own, key(message.entity, message.inReplyTo))
  }
  const groups = new Map<string, Message[]>()
  for (const message of messages) {
    const root = find(key(message.entity, message.messageId))
    groups.set(root, [...(groups.get(root) ?? []), message])
  }
  return groups
}

function sourceSpan(
  body: string,
  ask: boolean
): { start: number; end: number } | null {
  if (ask) {
    const match = askPattern.exec(body)
    if (match === null) return null
    let start = body.lastIndexOf("\n", match.index) + 1
    let end = body.indexOf("\n", match.index)
    if (end < 0) end = body.length
    while (start < end && /\s/.test(body[start] ?? "")) start++
    while (end > start && /\s/.test(body[end - 1] ?? "")) end--
    return end > start ? { start, end } : null
  }
  const start = body.search(/\S/)
  if (start < 0) return null
  const newline = body.indexOf("\n", start)
  const end = newline < 0 ? body.length : newline
  return end > start ? { start, end } : null
}

function party(
  addresses: readonly Address[],
  direction: ObligationDirection,
  own: ReadonlySet<string>
): string | null {
  const role = direction === "owed" ? "from" : "to"
  return (
    addresses.find(
      (entry) => entry.role === role && !own.has(lower(entry.address))
    )?.address ?? null
  )
}

function automated(message: Message, sender: string): boolean {
  return (
    message.listUnsubscribe === true ||
    (message.autoSubmitted !== null && lower(message.autoSubmitted) !== "no") ||
    /^(bulk|list|junk)$/i.test(message.precedence ?? "") ||
    /no[-_.]?reply|do[-_.]?not[-_.]?reply/i.test(sender)
  )
}

function candidates(
  now: Date,
  cfg: RepliesConfig,
  messages: readonly Message[]
): ReplyCandidate[] {
  const own = new Set(cfg.me.map(lower))
  const grouped = groupedMessages(messages)
  const result: ReplyCandidate[] = []
  for (const [key, group] of grouped) {
    const eligible = group.filter(
      (message) => message.occurred <= now.getTime()
    )
    eligible.sort(
      (a, b) =>
        a.occurred - b.occurred ||
        a.messageId.localeCompare(b.messageId) ||
        a.sha.localeCompare(b.sha)
    )
    const last = eligible.at(-1)
    if (last === undefined) continue
    const senders = last.addresses
      .filter((address) => address.role === "from")
      .map((address) => address.address)
    const sender = senders[0]
    if (sender === undefined) continue
    const isMine = own.has(lower(sender))
    let direction: ObligationDirection
    let days: number
    if (isMine) {
      direction = "waiting"
      days = cfg.waitingOn.afterDays
    } else {
      // Legacy records have no facts row. Unknown delivery headers never count as clean mail.
      if (last.listUnsubscribe === null || automated(last, sender)) continue
      const recipients = last.addresses
        .filter((address) => address.role === "to" || address.role === "cc")
        .map((address) => lower(address.address))
      const bcc = last.addresses
        .filter((address) => address.role === "bcc")
        .map((address) => lower(address.address))
      if (
        !recipients.some((recipient) => own.has(recipient)) ||
        bcc.some((address) => own.has(address))
      )
        continue
      direction = "owed"
      days = cfg.repliesOwed.afterDays
    }
    const other = party(last.addresses, direction, own)
    if (
      other === null ||
      cfg.excludeSenders.some((pattern) => new RegExp(pattern, "i").test(other))
    )
      continue
    if (now.getTime() - last.occurred < days * dayMs) continue
    const span = sourceSpan(last.body, direction === "waiting")
    if (span === null) continue
    result.push({
      threadId: key,
      direction,
      anchorMessageId: last.messageId,
      party: other,
      entityId: last.entity,
      dueAt: new Date(last.occurred + days * dayMs).toISOString(),
      source: { docSha256: last.sha, messageId: last.messageId, ...span },
    })
  }
  return result
}

export function detectReplies(now: Date, cfg: RepliesConfig): ReplyCandidate[] {
  return candidates(now, cfg, getMessages(cfg))
}

export function syncReplyObligations(
  now: Date,
  cfg: RepliesConfig
): { created: number; resolved: number } {
  const messages = getMessages(cfg)
  const found = candidates(now, cfg, messages)
  const byThread = groupedMessages(messages)
  // Resolve independently from qualification and delay: even a plain acknowledgment closes the
  // prior expectation as soon as it arrives. Dismissed obligations are never touched.
  const openRows = cfg.db
    .prepare(
      "SELECT id, entity_id, direction, thread_id, anchor_message_id, doc_id FROM obligations WHERE status = 'open' AND direction IS NOT NULL"
    )
    .all()
  let resolved = 0
  for (const row of openRows) {
    const entity = string(row, "entity_id")
    const direction = string(row, "direction")
    const anchor = string(row, "anchor_message_id") ?? ""
    const group =
      entity === null
        ? []
        : ([...byThread.values()].find((messagesInThread) =>
            messagesInThread.some(
              (message) =>
                message.entity === entity && message.messageId === anchor
            )
          ) ?? [])
    const anchorDocId = string(row, "doc_id")
    const anchorMessage = group.find(
      (message) => message.messageId === anchor && message.sha === anchorDocId
    )
    if (anchorMessage === undefined) continue
    const replied = group.some((message) => {
      if (
        message.occurred <= anchorMessage.occurred ||
        message.occurred > now.getTime()
      )
        return false
      const sender = message.addresses.find(
        (address) => address.role === "from"
      )?.address
      if (sender === undefined) return false
      const isMine = cfg.me.some((address) => lower(address) === lower(sender))
      return (
        (direction === "owed" && isMine) || (direction === "waiting" && !isMine)
      )
    })
    if (replied) {
      const id = number(row, "id")
      if (id === null) continue
      resolved += Number(
        cfg.db
          .prepare(
            "UPDATE obligations SET status = 'done', resolution_reason = 'replied' WHERE id = ? AND status = 'open'"
          )
          .run(id).changes
      )
    }
  }
  let created = 0
  const insert = cfg.db.prepare(
    "SELECT 1 FROM obligations WHERE entity_id = ? AND direction = ? AND anchor_message_id = ?"
  )
  for (const candidate of found) {
    if (
      insert.get(
        candidate.entityId,
        candidate.direction,
        candidate.anchorMessageId
      ) !== undefined
    )
      continue
    const source = messages.find(
      (message) => message.sha === candidate.source.docSha256
    )
    if (
      source === undefined ||
      source.body.slice(candidate.source.start, candidate.source.end).length ===
        0
    )
      continue
    const partyName = candidate.party
    const action =
      candidate.direction === "waiting"
        ? `Waiting on ${partyName}: ${source.title}`
        : `Reply to ${partyName}`
    insertObligation(cfg.db, {
      entityId: candidate.entityId,
      party: partyName,
      action,
      // The ledger persists UTC calendar dates; candidates preserve the full ISO timestamp.
      dueAt: candidate.dueAt.slice(0, 10),
      status: "open",
      docId: candidate.source.docSha256,
      span: {
        start: candidate.source.start,
        end: candidate.source.end,
        message_id: candidate.source.messageId,
      },
      direction: candidate.direction,
      threadId: candidate.threadId,
      anchorMessageId: candidate.anchorMessageId,
    })
    created++
  }
  return { created, resolved }
}
