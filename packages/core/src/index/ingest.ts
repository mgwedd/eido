import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { soundex, tokenize } from "./text"

export type MailAddressRole = "from" | "reply_to" | "to" | "cc" | "bcc"

export interface IndexedDocument {
  sha256: string
  source: string
  sourceRef: string
  mime: string
  entityId?: string
  blobPath?: string
  title?: string
  body: string
  /** Parser-confirmed pages; absent means source page provenance is unavailable. */
  pages?: { page: number; text: string }[]
  occurredAt?: string
  headers?: {
    messageId?: string
    inReplyTo?: string
    references?: string[]
    threadId?: string
    attachmentOf?: string
  }
  names?: { role: "from" | "to" | "cc"; name: string }[]
  /** Header addresses of a mail message, in header order within each role. */
  addresses?: { role: MailAddressRole; address: string }[]
  /** Parsed facts that distinguish known absence from legacy records not parsed with these fields. */
  mailFacts?: {
    listUnsubscribe: boolean
    autoSubmitted?: string
    precedence?: string
  }
  /** Account identity used to scope connector-native mail thread ids. */
  mailboxId?: string
  /** The canonical bytes the sha256 was computed from. When given, the digest is verified. */
  content?: Uint8Array
}

export interface IngestResult {
  inserted: number
  skipped: number
  /** Parser-confirmed page rows stored for new documents or safely backfilled on reparse. */
  pagesStored: number
  uidvalidityChanged: boolean
}

export interface Cursor {
  cursor: string
  uidvalidity?: string
}

export interface DocumentHeadChange {
  source: string
  sourceRef: string
  sha256: string | null
}

function storeMailMetadata(db: DatabaseSync, doc: IndexedDocument): void {
  if (doc.mailboxId !== undefined) {
    db.prepare(
      "INSERT OR IGNORE INTO mail_message_mailboxes (sha256, mailbox_id) VALUES (?, ?)"
    ).run(doc.sha256, doc.mailboxId.trim().toLowerCase())
  }
  const insertAddress = db.prepare(
    "INSERT OR IGNORE INTO mail_addresses (sha256, role, position, address) VALUES (?, ?, ?, ?)"
  )
  const positions = new Map<MailAddressRole, number>()
  for (const { role, address } of doc.addresses ?? []) {
    const position = positions.get(role) ?? 0
    positions.set(role, position + 1)
    insertAddress.run(doc.sha256, role, position, address)
  }
  if (doc.mailFacts !== undefined) {
    db.prepare(
      "INSERT OR IGNORE INTO mail_message_facts (sha256, list_unsubscribe, auto_submitted, precedence) VALUES (?, ?, ?, ?)"
    ).run(
      doc.sha256,
      doc.mailFacts.listUnsubscribe ? 1 : 0,
      doc.mailFacts.autoSubmitted ?? null,
      doc.mailFacts.precedence ?? null
    )
  }
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
): { inserted: boolean; pagesStored: number } {
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
  if (changes === 0) {
    const stored = db
      .prepare(
        "SELECT source, source_ref, mime, entity_id, blob_path FROM documents WHERE sha256 = ?"
      )
      .get(doc.sha256)
    if (
      stored === undefined ||
      stored["source"] !== doc.source ||
      stored["source_ref"] !== doc.sourceRef ||
      stored["mime"] !== doc.mime ||
      (stored["entity_id"] !== (doc.entityId ?? null) &&
        !(stored["entity_id"] === null && doc.entityId !== undefined)) ||
      stored["blob_path"] !== (doc.blobPath ?? null)
    )
      return { inserted: false, pagesStored: 0 }
    // A full connector resync can safely fill metadata absent from a legacy row only when the raw
    // bytes were supplied and hashed above. Header facts are immutable after their first insert.
    if (doc.content !== undefined && doc.mime === "message/rfc822")
      storeMailMetadata(db, doc)
    if (doc.pages === undefined || doc.pages.length === 0)
      return { inserted: false, pagesStored: 0 }
    const hasPages = db
      .prepare("SELECT 1 FROM document_pages WHERE sha256 = ? LIMIT 1")
      .get(doc.sha256)
    if (hasPages !== undefined) return { inserted: false, pagesStored: 0 }
    const insertPage = db.prepare(
      "INSERT INTO document_pages (sha256, page, text) VALUES (?, ?, ?)"
    )
    for (const page of doc.pages)
      insertPage.run(doc.sha256, page.page, page.text)
    return { inserted: false, pagesStored: doc.pages.length }
  }
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
  const insertPage = db.prepare(
    "INSERT INTO document_pages (sha256, page, text) VALUES (?, ?, ?)"
  )
  for (const page of doc.pages ?? [])
    insertPage.run(doc.sha256, page.page, page.text)
  const insertName = db.prepare(
    "INSERT INTO name_keys (sha256, role, name, phonetic_key) VALUES (?, ?, ?, ?)"
  )
  for (const { role, name } of doc.names ?? []) {
    for (const token of tokenize(name)) {
      const key = soundex(token)
      if (key !== null) insertName.run(doc.sha256, role, name, key)
    }
  }
  if (doc.mime === "message/rfc822") storeMailMetadata(db, doc)
  return { inserted: true, pagesStored: doc.pages?.length ?? 0 }
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
    heads?: DocumentHeadChange[]
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
    return {
      inserted: 0,
      skipped: 0,
      pagesStored: 0,
      uidvalidityChanged: true,
    }
  }
  const now = new Date().toISOString()
  let inserted = 0
  let skipped = 0
  let pagesStored = 0
  db.exec("BEGIN")
  try {
    for (const doc of args.documents) {
      const result = insertDocument(db, doc, now)
      if (result.inserted) inserted++
      else skipped++
      pagesStored += result.pagesStored
    }
    const setHead = db.prepare(
      `INSERT INTO document_heads (source, source_ref, sha256, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (source, source_ref) DO UPDATE SET
         sha256 = excluded.sha256, updated_at = excluded.updated_at`
    )
    for (const head of args.heads ?? [])
      setHead.run(head.source, head.sourceRef, head.sha256, now)
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
  return { inserted, skipped, pagesStored, uidvalidityChanged: false }
}
