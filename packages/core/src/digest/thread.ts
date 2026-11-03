import type { DatabaseSync } from "node:sqlite"
import type { DigestSubject, ThreadMessage } from "./types"

export interface ThreadKey {
  source: string
  entityId: string | null
  threadId: string
}

/** The digest subject id of a thread: the connector, the entity and the connector's thread id. */
export const threadSubjectId = (key: ThreadKey): string =>
  JSON.stringify([key.source, key.entityId, key.threadId])

export interface LoadedThread {
  subject: DigestSubject
  /** The stored document of each message, by the message's id in `subject`. */
  shaByMessageId: ReadonlyMap<string, string>
}

/** The thread a stored document belongs to, or undefined when it has no thread id. */
export function threadKeyOf(
  db: DatabaseSync,
  sha256: string
): ThreadKey | undefined {
  const row = db
    .prepare(
      `SELECT d.source, d.entity_id, t.thread_id FROM documents d
       JOIN document_text t ON t.sha256 = d.sha256 WHERE d.sha256 = ?`
    )
    .get(sha256)
  const threadId = row?.["thread_id"]
  if (row === undefined || typeof threadId !== "string" || threadId === "")
    return undefined
  const entityId = row["entity_id"]
  return {
    source: String(row["source"]),
    entityId: typeof entityId === "string" ? entityId : null,
    threadId,
  }
}

/**
 * The messages of a thread as stored, oldest first, as a digest subject. The message ids are
 * the ones digest cites use, so a cite maps back to its stored document.
 */
export function loadThread(
  db: DatabaseSync,
  key: ThreadKey
): LoadedThread | undefined {
  const rows = db
    .prepare(
      `SELECT d.sha256, d.source_ref, t.message_id, t.body, t.in_reply_to FROM documents d
       JOIN document_text t ON t.sha256 = d.sha256
       WHERE d.source = ? AND d.entity_id IS ? AND t.thread_id = ?
         AND d.mime = 'message/rfc822'
       ORDER BY COALESCE(t.occurred_at, ''), d.ingested_at, d.sha256`
    )
    .all(key.source, key.entityId, key.threadId)
  const messages: ThreadMessage[] = []
  const shaByMessageId = new Map<string, string>()
  for (const row of rows) {
    const id =
      typeof row["message_id"] === "string" && row["message_id"] !== ""
        ? row["message_id"]
        : typeof row["source_ref"] === "string"
          ? row["source_ref"]
          : row["sha256"]
    const body = row["body"]
    const inReplyTo = row["in_reply_to"]
    const sha256 = row["sha256"]
    if (
      typeof id !== "string" ||
      typeof body !== "string" ||
      typeof sha256 !== "string"
    )
      continue
    messages.push({
      id,
      body,
      ...(typeof inReplyTo === "string" ? { inReplyTo } : {}),
    })
    shaByMessageId.set(id, sha256)
  }
  if (messages.length === 0) return undefined
  return {
    subject: {
      kind: "thread",
      threadId: threadSubjectId(key),
      messages,
    },
    shaByMessageId,
  }
}
