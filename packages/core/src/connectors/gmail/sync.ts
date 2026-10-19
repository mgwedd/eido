import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { getCursor, ingestBatch } from "../../index/index"
import type { IndexedDocument } from "../../index/index"
import { attachmentText, parseMessage } from "../mail/parse"
import type { GmailClient, RawMessage } from "./client"
import type { GmailConfig } from "./config"
import { GmailError } from "./errors"
import { asObject, optionalString } from "./json"
import { GMAIL_CONNECTOR, GMAIL_SOURCE } from "./routes"

export type LabelSyncResult = {
  label: string
  inserted: number
  skipped: number
  /** True when the stored history id had expired and the label was read again, bounded. */
  resynced: boolean
}

/**
 * The cursor stored per label stream. `historyId` is where incremental sync resumes. While a full
 * sync is part way through, `pageToken` and `fetched` say where it stopped.
 */
type StreamCursor = { historyId: string; pageToken?: string; fetched?: number }

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex")

function readCursor(db: DatabaseSync, label: string): StreamCursor | undefined {
  const stored = getCursor(db, GMAIL_CONNECTOR, label)
  if (stored === null) return undefined
  let value: unknown
  try {
    value = JSON.parse(stored.cursor)
  } catch {
    return undefined
  }
  const object = asObject(value)
  if (object === undefined) return undefined
  const historyId = optionalString(object, "historyId")
  if (historyId === undefined) return undefined
  const pageToken = optionalString(object, "pageToken")
  const fetched = object["fetched"]
  return {
    historyId,
    ...(pageToken === undefined ? {} : { pageToken }),
    ...(typeof fetched === "number" ? { fetched } : {}),
  }
}

async function toDocuments(message: RawMessage): Promise<IndexedDocument[]> {
  const parsed = await parseMessage(message.raw)
  const contentHash = sha256(message.raw)
  const occurredAt =
    parsed.date ??
    (message.internalDate === undefined
      ? undefined
      : new Date(Number(message.internalDate)).toISOString())
  const mail: IndexedDocument = {
    sha256: contentHash,
    source: GMAIL_SOURCE,
    // Gmail's message id: stable for the life of the message, and what write verbs take.
    sourceRef: message.id,
    mime: "message/rfc822",
    title: parsed.subject,
    body: parsed.text,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    headers: {
      ...(parsed.messageId === undefined
        ? {}
        : { messageId: parsed.messageId }),
      ...(parsed.inReplyTo === undefined
        ? {}
        : { inReplyTo: parsed.inReplyTo }),
      references: parsed.references,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
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
  const attachments = parsed.attachments.map(
    (attachment, index): IndexedDocument => ({
      sha256: sha256(`${contentHash}:${index}`),
      source: GMAIL_SOURCE,
      sourceRef: `${message.id}#${index}`,
      mime: attachment.mime,
      title: attachment.filename,
      body: attachmentText(attachment) ?? "",
      headers: { attachmentOf: message.id },
    })
  )
  return [mail, ...attachments]
}

type Totals = { inserted: number; skipped: number }

/**
 * Fetches and parses the messages not yet in the index, then commits them with `nextCursor` in one
 * transaction. Ids already indexed are skipped before any fetch, so a repeated batch costs no
 * duplicate document; a message deleted since it was listed is skipped too.
 */
async function commitBatch(
  db: DatabaseSync,
  client: GmailClient,
  label: string,
  ids: readonly string[],
  nextCursor: StreamCursor,
  totals: Totals
): Promise<void> {
  const known = db.prepare(
    "SELECT 1 FROM documents WHERE source = ? AND source_ref = ? LIMIT 1"
  )
  const documents: IndexedDocument[] = []
  for (const id of new Set(ids)) {
    if (known.get(GMAIL_SOURCE, id) !== undefined) {
      totals.skipped++
      continue
    }
    let message: RawMessage
    try {
      message = await client.getMessage(id)
    } catch (error) {
      if (error instanceof GmailError && error.code === "not_found") continue
      throw error
    }
    documents.push(...(await toDocuments(message)))
  }
  const result = ingestBatch(db, {
    connector: GMAIL_CONNECTOR,
    stream: label,
    documents,
    nextCursor: JSON.stringify(nextCursor),
  })
  totals.inserted += result.inserted
  totals.skipped += result.skipped
}

/**
 * Pages the label's messages, newest first, up to `fullSyncLimit`. The history id is taken before
 * the first page, so whatever arrives during the sync is picked up by the next incremental run.
 */
async function fullSync(
  db: DatabaseSync,
  client: GmailClient,
  label: string,
  config: GmailConfig,
  resume: StreamCursor | undefined,
  totals: Totals
): Promise<void> {
  const historyId = resume?.historyId ?? (await client.getProfile()).historyId
  let pageToken = resume?.pageToken
  let fetched = resume?.fetched ?? 0
  for (;;) {
    const limit = Math.min(config.batchSize, config.fullSyncLimit - fetched)
    const page = await client.searchMessages("", {
      limit,
      labelIds: [label],
      ...(pageToken === undefined ? {} : { pageToken }),
    })
    fetched += page.messages.length
    pageToken = page.nextPageToken
    // An empty page ends the sync even with a token, so a bad answer cannot loop forever.
    const more =
      pageToken !== undefined &&
      page.messages.length > 0 &&
      fetched < config.fullSyncLimit
    await commitBatch(
      db,
      client,
      label,
      page.messages.map((m) => m.id),
      more ? { historyId, pageToken, fetched } : { historyId },
      totals
    )
    if (!more) return
  }
}

/** Replays history since the stored id. Only the last page moves the stored history id forward. */
async function incrementalSync(
  db: DatabaseSync,
  client: GmailClient,
  label: string,
  config: GmailConfig,
  historyId: string,
  totals: Totals
): Promise<void> {
  let pageToken: string | undefined
  for (;;) {
    const page = await client.listHistory(historyId, {
      labelId: label,
      limit: config.batchSize,
      ...(pageToken === undefined ? {} : { pageToken }),
    })
    pageToken = page.nextPageToken
    await commitBatch(
      db,
      client,
      label,
      page.messageIds,
      { historyId: pageToken === undefined ? page.historyId : historyId },
      totals
    )
    if (pageToken === undefined) return
  }
}

/**
 * Brings one label up to date. With no cursor, or a full sync still in progress, it runs or
 * resumes the bounded full sync; otherwise it replays history. An expired history id (404) falls
 * back to a bounded full resync, deduped on Gmail message id. Each batch and its cursor commit
 * together, so a sync stopped anywhere resumes without duplicates.
 */
export async function syncGmailLabel(
  db: DatabaseSync,
  client: GmailClient,
  label: string,
  config: GmailConfig
): Promise<LabelSyncResult> {
  const totals: Totals = { inserted: 0, skipped: 0 }
  const cursor = readCursor(db, label)
  if (cursor === undefined) {
    await fullSync(db, client, label, config, undefined, totals)
    return { label, ...totals, resynced: false }
  }
  if (cursor.pageToken !== undefined) {
    try {
      await fullSync(db, client, label, config, cursor, totals)
      return { label, ...totals, resynced: false }
    } catch (error) {
      // Gmail no longer accepts the stored page token: start the bounded full sync again.
      if (!(error instanceof GmailError) || error.status !== 400) throw error
    }
    await fullSync(db, client, label, config, undefined, totals)
    return { label, ...totals, resynced: true }
  }
  try {
    await incrementalSync(db, client, label, config, cursor.historyId, totals)
    return { label, ...totals, resynced: false }
  } catch (error) {
    if (!(error instanceof GmailError) || error.code !== "history_expired")
      throw error
  }
  await fullSync(db, client, label, config, undefined, totals)
  return { label, ...totals, resynced: true }
}

/**
 * Syncs every configured label in order. The first failure stops the run: a revoked grant
 * (`grant_revoked`) or an unreachable gate is not retried per label or in a loop. Health (#24)
 * decides when to try again.
 */
export async function syncGmail(
  db: DatabaseSync,
  client: GmailClient,
  config: GmailConfig
): Promise<LabelSyncResult[]> {
  const results: LabelSyncResult[] = []
  for (const label of config.labels)
    results.push(await syncGmailLabel(db, client, label, config))
  return results
}
