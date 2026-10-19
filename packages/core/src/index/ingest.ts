import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { soundex, tokenize } from "./text"

export interface IndexedDocument {
  sha256: string
  source: string
  sourceRef: string
  mime: string
  entityId?: string
  blobPath?: string
  title?: string
  body: string
  occurredAt?: string
  headers?: {
    messageId?: string
    inReplyTo?: string
    references?: string[]
    threadId?: string
    attachmentOf?: string
  }
  names?: { role: "from" | "to" | "cc"; name: string }[]
  /** The canonical bytes the sha256 was computed from. When given, the digest is verified. */
  content?: Uint8Array
}

export interface IngestResult {
  inserted: number
  skipped: number
  uidvalidityChanged: boolean
}

export interface Cursor {
  cursor: string
  uidvalidity?: string
}

export function getCursor(
  db: DatabaseSync,
  connector: string,
  stream: string
): Cursor | null {
  const row = db
    .prepare(
      "SELECT cursor, uidvalidity FROM cursors WHERE connector = ? AND stream = ?"
    )
    .get(connector, stream)
  if (row === undefined) return null
  const uidvalidity = row["uidvalidity"]
  return {
    cursor: String(row["cursor"]),
    ...(typeof uidvalidity === "string" ? { uidvalidity } : {}),
  }
}

function insertDocument(
  db: DatabaseSync,
  doc: IndexedDocument,
  now: string
): boolean {
  if (doc.content !== undefined) {
    const digest = createHash("sha256").update(doc.content).digest("hex")
    if (digest !== doc.sha256)
      throw new Error(`sha256 mismatch for ${doc.sourceRef}`)
  }
  const { changes } = db
    .prepare(
      `INSERT OR IGNORE INTO documents (sha256, source, source_ref, mime, entity_id, ingested_at, blob_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      doc.sha256,
      doc.source,
      doc.sourceRef,
      doc.mime,
      doc.entityId ?? null,
      now,
      doc.blobPath ?? null
    )
  if (changes === 0) return false
  const h = doc.headers
  db.prepare(
    `INSERT INTO document_text (sha256, title, body, occurred_at, message_id, in_reply_to, references_json, thread_id, attachment_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    doc.sha256,
    doc.title ?? null,
    doc.body,
    doc.occurredAt ?? null,
    h?.messageId ?? null,
    h?.inReplyTo ?? null,
    h?.references === undefined ? null : JSON.stringify(h.references),
    h?.threadId ?? null,
    h?.attachmentOf ?? null
  )
  const insertName = db.prepare(
    "INSERT INTO name_keys (sha256, role, name, phonetic_key) VALUES (?, ?, ?, ?)"
  )
  for (const { role, name } of doc.names ?? []) {
    for (const token of tokenize(name)) {
      const key = soundex(token)
      if (key !== null) insertName.run(doc.sha256, role, name, key)
    }
  }
  return true
}

/**
 * Store a batch and advance the cursor in one transaction. Documents are immutable: a repeat sha256 is
 * counted in `skipped`. If the stored uidvalidity differs from the given one, nothing is written and the
 * caller must do the full resync.
 */
export function ingestBatch(
  db: DatabaseSync,
  args: {
    connector: string
    stream: string
    documents: IndexedDocument[]
    nextCursor: string
    uidvalidity?: string
  }
): IngestResult {
  const stored = getCursor(db, args.connector, args.stream)
  if (
    stored?.uidvalidity !== undefined &&
    args.uidvalidity !== undefined &&
    stored.uidvalidity !== args.uidvalidity
  ) {
    return { inserted: 0, skipped: 0, uidvalidityChanged: true }
  }
  const now = new Date().toISOString()
  let inserted = 0
  let skipped = 0
  db.exec("BEGIN")
  try {
    for (const doc of args.documents) {
      if (insertDocument(db, doc, now)) inserted++
      else skipped++
    }
    db.prepare(
      `INSERT INTO cursors (connector, stream, cursor, uidvalidity, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (connector, stream) DO UPDATE SET
         cursor = excluded.cursor, uidvalidity = excluded.uidvalidity, updated_at = excluded.updated_at`
    ).run(
      args.connector,
      args.stream,
      args.nextCursor,
      args.uidvalidity ?? null,
      now
    )
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  return { inserted, skipped, uidvalidityChanged: false }
}
