import type { DatabaseSync } from "node:sqlite"
import type { DigestService } from "./service"
import { loadThread } from "./thread"
import type { DigestSubject } from "./types"
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

  for (const thread of threads.values()) {
    const loaded = loadThread(db, thread)
    if (loaded !== undefined) service.scheduleDigest(loaded.subject)
  }
}
