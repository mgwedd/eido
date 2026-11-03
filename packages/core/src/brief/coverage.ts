import type { DatabaseSync } from "node:sqlite"
import type { BriefCoverage } from "./types"

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/**
 * "Read N new messages and M documents since yesterday" when everything in the window was read,
 * "Read N of T new messages and M of D documents" when some was not. A brief with no lines opens
 * with "Nothing new or due." and drops "since yesterday".
 */
export function coverageLine(
  coverage: BriefCoverage,
  hasLines: boolean
): string {
  const complete =
    coverage.messagesRead === coverage.messagesTotal &&
    coverage.documentsRead === coverage.documentsTotal
  const messages = complete
    ? plural(coverage.messagesRead, "new message", "new messages")
    : `${coverage.messagesRead} of ${plural(coverage.messagesTotal, "new message", "new messages")}`
  const documents = complete
    ? plural(coverage.documentsRead, "document", "documents")
    : `${coverage.documentsRead} of ${plural(coverage.documentsTotal, "document", "documents")}`
  const read = `Read ${messages} and ${documents}`
  return hasLines
    ? `${read}${complete ? " since yesterday" : ""}`
    : `Nothing new or due. ${read}.`
}

/**
 * Counts documents ingested in (windowStart, windowEnd]. A document is read once it has an
 * extraction row, including `processed_empty`; one whose extraction was rejected has none. The
 * counts come from queries only.
 */
export function windowCoverage(
  db: DatabaseSync,
  windowStart: string,
  windowEnd: string
): Omit<BriefCoverage, "skipped"> {
  const rows = db
    .prepare(
      `SELECT d.mime = 'message/rfc822' AS is_message,
              COUNT(*) AS total,
              SUM(EXISTS (SELECT 1 FROM extractions e WHERE e.doc_id = d.sha256)) AS read
       FROM documents d
       WHERE d.ingested_at > ? AND d.ingested_at <= ?
       GROUP BY is_message`
    )
    .all(windowStart, windowEnd)
  const counts = { messages: [0, 0], documents: [0, 0] }
  for (const row of rows) {
    const bucket = row["is_message"] === 1 ? counts.messages : counts.documents
    bucket[0] = Number(row["read"])
    bucket[1] = Number(row["total"])
  }
  return {
    messagesRead: counts.messages[0] ?? 0,
    messagesTotal: counts.messages[1] ?? 0,
    documentsRead: counts.documents[0] ?? 0,
    documentsTotal: counts.documents[1] ?? 0,
    windowStart,
    windowEnd,
  }
}
