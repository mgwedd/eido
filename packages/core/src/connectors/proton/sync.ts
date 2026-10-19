import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { getCursor, ingestBatch } from "../../index"
import type { IndexedDocument } from "../../index"
import type { FetchedMessage, ImapClient } from "./imap-client"
import { parseMessage } from "./mime"

export const CONNECTOR = "proton"

export type FolderSyncResult = {
  folder: string
  inserted: number
  skipped: number
  /** True when UIDVALIDITY changed and the folder was read again from the start. */
  resynced: boolean
}

function toDocument(
  message: FetchedMessage,
  folder: string,
  uidvalidity: string
): IndexedDocument {
  const parsed = parseMessage(message.raw)
  const thread = parsed.references[0] ?? parsed.inReplyTo ?? parsed.messageId
  return {
    sha256: createHash("sha256").update(message.raw).digest("hex"),
    source: CONNECTOR,
    // The Message-ID is the stable identity; a UID is only unique within one UIDVALIDITY epoch.
    sourceRef:
      parsed.messageId ?? `proton:${folder}:${uidvalidity}:${message.uid}`,
    mime: "message/rfc822",
    body: parsed.text,
    title: parsed.subject,
    ...(parsed.date === undefined ? {} : { occurredAt: parsed.date }),
    headers: {
      ...(parsed.messageId === undefined
        ? {}
        : { messageId: parsed.messageId }),
      ...(parsed.inReplyTo === undefined
        ? {}
        : { inReplyTo: parsed.inReplyTo }),
      references: parsed.references,
      ...(thread === undefined ? {} : { threadId: thread }),
    },
    names: [
      ...parsed.from.map((a) => ({
        role: "from" as const,
        name: a.name ?? a.address,
      })),
      ...parsed.to.map((a) => ({
        role: "to" as const,
        name: a.name ?? a.address,
      })),
      ...parsed.cc.map((a) => ({
        role: "cc" as const,
        name: a.name ?? a.address,
      })),
    ],
    content: message.raw,
  }
}

/**
 * Brings one folder up to date in bounded UID batches. The cursor (last UID covered) and the
 * batch's documents commit together, so a sync stopped anywhere resumes from the stored cursor.
 * Dedupe is by content hash (the index) and by Message-ID (here), so a message that appears in two
 * folders, or again after a UIDVALIDITY reset, is stored once.
 */
export async function syncFolder(
  db: DatabaseSync,
  client: ImapClient,
  folder: string,
  batchSize: number
): Promise<FolderSyncResult> {
  const state = await client.select(folder)
  const stored = getCursor(db, CONNECTOR, folder)
  const resynced =
    stored?.uidvalidity !== undefined &&
    stored.uidvalidity !== state.uidvalidity
  if (resynced) {
    // The server renumbered the folder: the old UID cursor means nothing. Start again from UID 1.
    db.prepare("DELETE FROM cursors WHERE connector = ? AND stream = ?").run(
      CONNECTOR,
      folder
    )
  }
  let covered = resynced || stored === null ? 0 : Number(stored.cursor)
  const lastUid = state.uidnext - 1
  const known = db.prepare(
    "SELECT 1 FROM document_text WHERE message_id = ? LIMIT 1"
  )
  let inserted = 0
  let skipped = 0
  while (covered < lastUid) {
    const from = covered + 1
    const to = Math.min(covered + batchSize, lastUid)
    const fetched = await client.fetchRange(from, to)
    const seen = new Set<string>()
    const documents: IndexedDocument[] = []
    let duplicates = 0
    for (const message of fetched) {
      const doc = toDocument(message, folder, state.uidvalidity)
      const id = doc.headers?.messageId
      if (id !== undefined && (seen.has(id) || known.get(id) !== undefined)) {
        duplicates++
        continue
      }
      if (id !== undefined) seen.add(id)
      documents.push(doc)
    }
    const result = ingestBatch(db, {
      connector: CONNECTOR,
      stream: folder,
      documents,
      nextCursor: String(to),
      uidvalidity: state.uidvalidity,
    })
    inserted += result.inserted
    skipped += result.skipped + duplicates
    covered = to
  }
  if (stored === null || resynced) {
    // An empty folder still records its UIDVALIDITY, so a later change is detected.
    ingestBatch(db, {
      connector: CONNECTOR,
      stream: folder,
      documents: [],
      nextCursor: String(covered),
      uidvalidity: state.uidvalidity,
    })
  }
  return { folder, inserted, skipped, resynced }
}
