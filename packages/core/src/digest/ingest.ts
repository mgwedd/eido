import type { DatabaseSync } from "node:sqlite"
import type { DigestService } from "./service"
import type { DigestSubject, ThreadMessage } from "./types"
import type { IndexedDocument } from "../index/ingest"

/** Schedule digests only from rows committed by ingestion and persisted page provenance. */
export function scheduleIngestedDigests(
  db: DatabaseSync,
  service: Pick<DigestService, "scheduleDigest">,
  documents: readonly IndexedDocument[]
): void {
  const threads = new Map<
    string,
    { source: string; entityId: string | null; threadId: string }
  >()
  const pagesQuery = db.prepare(
    "SELECT page, text FROM document_pages WHERE sha256 = ? ORDER BY page"
  )

  for (const document of documents) {
    const threadId = document.headers?.threadId
    if (threadId !== undefined) {
      const source = {
        source: document.source,
        entityId: document.entityId ?? null,
        threadId,
      }
      threads.set(
        JSON.stringify([source.source, source.entityId, source.threadId]),
        source
      )
    }

    const rows = pagesQuery.all(document.sha256)
    const pages = rows.flatMap((row) => {
      const page = row["page"]
      const text = row["text"]
      return typeof page === "number" && typeof text === "string"
        ? [{ page, text }]
        : []
    })
    // Existing rows from before page provenance, non-page documents, and failed parses cannot
    // produce source-valid citations. They remain searchable until a later reparse stores pages.
    if (pages.length > 0) {
      const subject: DigestSubject = {
        kind: "document",
        docSha256: document.sha256,
        pages,
      }
      service.scheduleDigest(subject)
    }
  }

  const messages = db.prepare(
    `SELECT d.sha256, d.source_ref, t.message_id, t.body, t.in_reply_to FROM documents d
     JOIN document_text t ON t.sha256 = d.sha256
     WHERE d.source = ? AND d.entity_id IS ? AND t.thread_id = ?
       AND d.mime = 'message/rfc822'
     ORDER BY COALESCE(t.occurred_at, ''), d.ingested_at, d.sha256`
  )
  for (const [subjectThreadId, thread] of threads) {
    const threadMessages: ThreadMessage[] = messages
      .all(thread.source, thread.entityId, thread.threadId)
      .flatMap((row) => {
        const id =
          typeof row["message_id"] === "string" && row["message_id"] !== ""
            ? row["message_id"]
            : typeof row["source_ref"] === "string"
              ? row["source_ref"]
              : row["sha256"]
        const body = row["body"]
        const inReplyTo = row["in_reply_to"]
        if (typeof id !== "string" || typeof body !== "string") return []
        return [
          {
            id,
            body,
            ...(typeof inReplyTo === "string" ? { inReplyTo } : {}),
          },
        ]
      })
    if (threadMessages.length === 0) continue
    service.scheduleDigest({
      kind: "thread",
      threadId: subjectThreadId,
      messages: threadMessages,
    })
  }
}
