import type { DatabaseSync } from "node:sqlite"

export type DocumentTypeSource = "model" | "user"

export interface DocumentType {
  type: string
  source: DocumentTypeSource
}

export const MAX_DOCUMENT_TYPE_LENGTH = 100

/**
 * Store the semantic type of a stored document with who set it. A later label replaces an earlier
 * one, except that a model label never replaces a user label (the table enforces it too).
 * Returns false when the document is not stored or the type is empty or too long.
 */
export function setDocumentType(
  db: DatabaseSync,
  sha256: string,
  value: DocumentType,
  now: Date = new Date()
): boolean {
  const type = value.type.trim()
  if (type === "" || type.length > MAX_DOCUMENT_TYPE_LENGTH) return false
  const stored = db
    .prepare("SELECT 1 AS ok FROM documents WHERE sha256 = ?")
    .get(sha256)
  if (stored === undefined) return false
  db.prepare(
    `INSERT INTO document_types (sha256, type, source, set_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (sha256) DO UPDATE SET type = excluded.type, source = excluded.source,
       set_at = excluded.set_at
     WHERE NOT (document_types.source = 'user' AND excluded.source = 'model')`
  ).run(sha256, type, value.source, now.toISOString())
  return true
}

/** The stored type of a document, or null when it has none. */
export function getDocumentType(
  db: DatabaseSync,
  sha256: string
): DocumentType | null {
  const row = db
    .prepare("SELECT type, source FROM document_types WHERE sha256 = ?")
    .get(sha256)
  if (row === undefined) return null
  const { type, source } = row
  if (typeof type !== "string" || (source !== "model" && source !== "user")) {
    throw new Error("stored document type is malformed")
  }
  return { type, source }
}
