import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { getCursor, ingestBatch } from "../../index/index"
import type { IndexedDocument } from "../../index/index"
import { ingestEntityId } from "../ingest-entity"
import type { IngestAccount, IngestEntities } from "../ingest-entity"
import type { ProtonConfig } from "./config"
import { isTextMime, parseMessage, attachmentText } from "../mail/parse"
import { extractAddresses } from "../reply-target"
import { callSource } from "./source"
import type { ProtonMailSource } from "./source"

export const CONNECTOR = "proton"

export type FolderSyncResult = {
  folder: string
  inserted: number
  skipped: number
  /** True when UIDVALIDITY changed and the folder was read again from the start. */
  resynced: boolean
}

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex")

function skippedDocument(
  folder: string,
  uidValidity: string,
  uid: number,
  entityId: string
): IndexedDocument {
  const sourceRef = `proton:skipped:${folder}:${uidValidity}:${uid}`
  return {
    sha256: sha256(sourceRef),
    source: CONNECTOR,
    sourceRef,
    mime: "application/x-eido-proton-skipped",
    entityId,
    title: "Oversized Proton message",
    body: "This message exceeds the Proton Bridge 25 MiB size limit and was not indexed.",
  }
}

async function toDocuments(
  raw: Uint8Array,
  folder: string,
  uidValidity: string,
  uid: number,
  entityId: string
): Promise<IndexedDocument[]> {
  const parsed = await parseMessage(raw)
  const contentHash = sha256(raw)
  // The Message-ID is the stable identity; a UID is only unique within one UIDVALIDITY epoch.
  const key = parsed.messageId ?? `proton:${folder}:${uidValidity}:${uid}`
  const thread = parsed.references[0] ?? parsed.inReplyTo ?? key
  const message: IndexedDocument = {
    sha256: contentHash,
    source: CONNECTOR,
    sourceRef: key,
    mime: "message/rfc822",
    entityId,
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
      threadId: thread,
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
    addresses: extractAddresses(parsed),
    content: raw,
  }
  // One document per attachment, keyed off the message's hash so the same file attached to two
  // different messages stays reachable from both. Non-text attachments are recorded with no text.
  const attachments = parsed.attachments.map(
    (attachment, index): IndexedDocument => ({
      sha256: sha256(`${contentHash}:${index}`),
      source: CONNECTOR,
      sourceRef: `${key}#${index}`,
      mime: attachment.mime,
      entityId,
      title: attachment.filename,
      body: isTextMime(attachment.mime)
        ? (attachmentText(attachment) ?? "")
        : "",
      headers: { attachmentOf: key },
    })
  )
  return [message, ...attachments]
}

/**
 * Brings one folder up to date in bounded UID batches. The cursor (last UID processed) and the
 * batch's documents commit together, so a sync stopped anywhere resumes from the stored cursor.
 * Dedupe is by content hash (the index) and by Message-ID (here), so a message that appears in two
 * folders, or again after a UIDVALIDITY reset, is stored once.
 *
 * Every document is stored with the account's entity (its assignment, else the default entity).
 * With neither, it throws EntityRequiredError before reading the folder: nothing is stored and the
 * cursor stays where it was.
 */
export async function syncFolder(
  db: DatabaseSync,
  source: ProtonMailSource,
  folder: string,
  batchSize: number,
  account: IngestAccount
): Promise<FolderSyncResult> {
  const entityId = await ingestEntityId(CONNECTOR, account)
  const state = await callSource(() => source.folderState(folder))
  const stored = getCursor(db, CONNECTOR, folder)
  const resynced =
    stored?.uidvalidity !== undefined &&
    stored.uidvalidity !== state.uidValidity
  if (resynced) {
    // The server renumbered the folder: the old UID cursor means nothing. Start again from UID 1.
    db.prepare("DELETE FROM cursors WHERE connector = ? AND stream = ?").run(
      CONNECTOR,
      folder
    )
  }
  let covered = resynced || stored === null ? 0 : Number(stored.cursor)
  const known = db.prepare(
    "SELECT 1 FROM document_text WHERE message_id = ? LIMIT 1"
  )
  let inserted = 0
  let skipped = 0
  while (covered + 1 < state.uidNext) {
    const from = covered + 1
    const page = await callSource(() =>
      source.fetchRaw(folder, from, batchSize)
    )
    const fetched = page.messages.filter((m) => m.uid >= from)
    const skippedUids = page.skipped.filter((uid) => uid >= from)
    if (fetched.length === 0 && skippedUids.length === 0) {
      covered = state.uidNext - 1
      break
    }
    const seen = new Set<string>()
    const documents: IndexedDocument[] = []
    let duplicates = 0
    for (const message of fetched) {
      const docs = await toDocuments(
        message.raw,
        folder,
        state.uidValidity,
        message.uid,
        entityId
      )
      const id = docs[0]?.headers?.messageId
      if (id !== undefined && (seen.has(id) || known.get(id) !== undefined)) {
        duplicates++
        continue
      }
      if (id !== undefined) seen.add(id)
      documents.push(...docs)
    }
    for (const uid of skippedUids)
      documents.push(skippedDocument(folder, state.uidValidity, uid, entityId))
    const last = Math.max(
      fetched[fetched.length - 1]?.uid ?? from - 1,
      skippedUids[skippedUids.length - 1] ?? from - 1
    )
    const result = ingestBatch(db, {
      connector: CONNECTOR,
      stream: folder,
      documents,
      nextCursor: String(last),
      uidvalidity: state.uidValidity,
    })
    inserted += result.inserted
    skipped += result.skipped + duplicates + skippedUids.length
    covered = last
  }
  // Records the position reached with an empty tail, and the UIDVALIDITY of a folder with no
  // mail, so a later change is detected.
  if (stored === null || resynced || covered !== Number(stored.cursor)) {
    ingestBatch(db, {
      connector: CONNECTOR,
      stream: folder,
      documents: [],
      nextCursor: String(covered),
      uidvalidity: state.uidValidity,
    })
  }
  return { folder, inserted, skipped, resynced }
}

/**
 * Syncs every configured folder in order. The first typed failure (`auth_failed`,
 * `handshake_failed`, gate unavailable) stops the run: the same bad credentials are not retried per
 * folder or in a loop. Health (#24) decides when to try again. The account is the Bridge
 * username.
 */
export async function syncProton(
  db: DatabaseSync,
  source: ProtonMailSource,
  config: ProtonConfig,
  entities: IngestEntities
): Promise<FolderSyncResult[]> {
  const account: IngestAccount = { accountRef: config.username, entities }
  const results: FolderSyncResult[] = []
  for (const folder of config.folders)
    results.push(
      await syncFolder(db, source, folder, config.batchSize, account)
    )
  return results
}
