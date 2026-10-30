import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { getCursor, ingestBatch } from "../../index/index"
import type { IndexedDocument } from "../../index/index"
import { ingestEntityId } from "../ingest-entity"
import type { IngestAccount } from "../ingest-entity"
import { isPdfMime, attachmentText, parseMessage } from "../mail/parse"
import { pdfAttachmentText } from "../mail/pdf-text"
import type { Parser } from "../../parsers/index"
import { extractAddresses } from "../reply-target"
import type { GmailClient, RawMessage } from "./client"
import type { GmailConfig } from "./config"
import { GmailError } from "./errors"
import { asObject, optionalString } from "./json"
import { GMAIL_CONNECTOR, GMAIL_SOURCE } from "./routes"
import { healthAwareSyncRunner } from "../health-aware-sync"
import type { ConnectorHealthReader } from "../health-aware-sync"

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

async function toDocuments(
  message: RawMessage,
  entityId: string,
  parser: Parser | undefined,
  mailboxId: string
): Promise<IndexedDocument[]> {
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
    entityId,
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
    addresses: extractAddresses(parsed),
    mailboxId,
    mailFacts: {
      listUnsubscribe: parsed.listUnsubscribe,
      ...(parsed.autoSubmitted === undefined
        ? {}
        : { autoSubmitted: parsed.autoSubmitted }),
      ...(parsed.precedence === undefined
        ? {}
        : { precedence: parsed.precedence }),
    },
    content: message.raw,
  }
  const attachments: IndexedDocument[] = []
  for (const [index, attachment] of parsed.attachments.entries()) {
    // A PDF's text and pages come from the sandboxed parser. If parsing fails, it has no
    // page provenance, so it remains searchable but no page-citing digest is scheduled.
    const pdf =
      parser !== undefined && isPdfMime(attachment.mime)
        ? await pdfAttachmentText(parser, attachment)
        : null
    const body =
      pdf?.text ??
      (isPdfMime(attachment.mime) ? null : attachmentText(attachment))
    attachments.push({
      sha256: sha256(`${contentHash}:${index}`),
      source: GMAIL_SOURCE,
      sourceRef: `${message.id}#${index}`,
      mime: attachment.mime,
      entityId,
      title: attachment.filename,
      body: body ?? "",
      ...(pdf === null ? {} : { pages: pdf.pages }),
      headers: { attachmentOf: message.id },
    })
  }
  return [mail, ...attachments]
}

export type SyncOptions = {
  /** Reads PDF attachments. Without it a PDF is indexed with no text. */
  parser?: Parser
  /** Called after the transaction commits, with documents submitted to that batch. */
  onIngested?: (documents: readonly IndexedDocument[]) => void
  /** Called after every committed page, including pages that only backfill parsed metadata. */
  onBatchCommitted?: () => void
}

type Totals = { inserted: number; skipped: number }

/** What one label's sync works with. Every document it stores gets `entityId`. */
type LabelRun = {
  db: DatabaseSync
  client: GmailClient
  label: string
  config: GmailConfig
  entityId: string
  mailboxId: string
  totals: Totals
  parser: Parser | undefined
  onIngested: SyncOptions["onIngested"]
  onBatchCommitted: SyncOptions["onBatchCommitted"]
}

/**
 * Fetches and parses messages not yet in the index, then commits them with `nextCursor` in one
 * transaction. Indexed messages are skipped unless a PDF attachment lacks stored parser pages;
 * that bounded full-sync reparse can add provenance without replacing the immutable document.
 * A message deleted since it was listed is skipped too.
 */
async function commitBatch(
  {
    db,
    client,
    label,
    entityId,
    mailboxId,
    totals,
    parser,
    onIngested,
    onBatchCommitted,
  }: LabelRun,
  ids: readonly string[],
  nextCursor: StreamCursor
): Promise<void> {
  const known = db.prepare(
    `SELECT 1 FROM documents d JOIN mail_message_mailboxes m ON m.sha256 = d.sha256
     WHERE d.source = ? AND d.source_ref = ? AND m.mailbox_id = ? LIMIT 1`
  )
  const missingPdfPages = db.prepare(
    `SELECT 1 FROM documents d
     JOIN document_text t ON t.sha256 = d.sha256
     WHERE d.source = ? AND t.attachment_of = ? AND d.mime = 'application/pdf'
       AND NOT EXISTS (
         SELECT 1 FROM document_pages p WHERE p.sha256 = d.sha256
       )
     LIMIT 1`
  )
  const documents: IndexedDocument[] = []
  for (const id of new Set(ids)) {
    if (
      known.get(GMAIL_SOURCE, id, mailboxId.trim().toLowerCase()) !==
        undefined &&
      (parser === undefined ||
        missingPdfPages.get(GMAIL_SOURCE, id) === undefined)
    ) {
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
    documents.push(...(await toDocuments(message, entityId, parser, mailboxId)))
  }
  const result = ingestBatch(db, {
    connector: GMAIL_CONNECTOR,
    stream: label,
    documents,
    nextCursor: JSON.stringify(nextCursor),
  })
  totals.inserted += result.inserted
  totals.skipped += result.skipped
  if (result.inserted > 0 || result.pagesStored > 0) onIngested?.(documents)
  onBatchCommitted?.()
}

/**
 * Pages the label's messages, newest first, up to `fullSyncLimit`. The history id is taken before
 * the first page, so whatever arrives during the sync is picked up by the next incremental run.
 */
async function fullSync(
  run: LabelRun,
  resume: StreamCursor | undefined
): Promise<void> {
  const { client, label, config } = run
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
      run,
      page.messages.map((m) => m.id),
      more ? { historyId, pageToken, fetched } : { historyId }
    )
    if (!more) return
  }
}

/** Replays history since the stored id. Only the last page moves the stored history id forward. */
async function incrementalSync(
  run: LabelRun,
  historyId: string
): Promise<void> {
  const { client, label, config } = run
  let pageToken: string | undefined
  for (;;) {
    const page = await client.listHistory(historyId, {
      labelId: label,
      limit: config.batchSize,
      ...(pageToken === undefined ? {} : { pageToken }),
    })
    pageToken = page.nextPageToken
    await commitBatch(run, page.messageIds, {
      historyId: pageToken === undefined ? page.historyId : historyId,
    })
    if (pageToken === undefined) return
  }
}

/**
 * Brings one label up to date. With no cursor, or a full sync still in progress, it runs or
 * resumes the bounded full sync; otherwise it replays history. An expired history id (404) falls
 * back to a bounded full resync, deduped on Gmail message id. Each batch and its cursor commit
 * together, so a sync stopped anywhere resumes without duplicates.
 *
 * Every document is stored with the account's entity (its assignment, else the default entity).
 * With neither, it throws EntityRequiredError before reading Gmail: nothing is stored and the
 * cursor stays where it was.
 */
export async function syncGmailLabel(
  db: DatabaseSync,
  client: GmailClient,
  label: string,
  config: GmailConfig,
  account: IngestAccount,
  options: SyncOptions = {}
): Promise<LabelSyncResult> {
  const entityId = await ingestEntityId(GMAIL_CONNECTOR, account)
  const mailboxId = account.accountRef
  const totals: Totals = { inserted: 0, skipped: 0 }
  const run: LabelRun = {
    db,
    client,
    label,
    config,
    entityId,
    mailboxId,
    totals,
    parser: options.parser,
    onIngested: options.onIngested,
    onBatchCommitted: options.onBatchCommitted,
  }
  const cursor = readCursor(db, label)
  if (cursor === undefined) {
    await fullSync(run, undefined)
    return { label, ...totals, resynced: false }
  }
  if (cursor.pageToken !== undefined) {
    try {
      await fullSync(run, cursor)
      return { label, ...totals, resynced: false }
    } catch (error) {
      // Gmail no longer accepts the stored page token: start the bounded full sync again.
      if (!(error instanceof GmailError) || error.status !== 400) throw error
    }
    await fullSync(run, undefined)
    return { label, ...totals, resynced: true }
  }
  try {
    await incrementalSync(run, cursor.historyId)
    return { label, ...totals, resynced: false }
  } catch (error) {
    if (!(error instanceof GmailError) || error.code !== "history_expired")
      throw error
  }
  await fullSync(run, undefined)
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
  config: GmailConfig,
  account: IngestAccount,
  options: SyncOptions = {}
): Promise<LabelSyncResult[]> {
  const results: LabelSyncResult[] = []
  for (const label of config.labels)
    results.push(
      await syncGmailLabel(db, client, label, config, account, options)
    )
  return results
}

/** Runs Gmail's existing cursor-safe sync only while the gate says the connector may be tried. */
export async function syncGmailWithHealth(
  gate: ConnectorHealthReader,
  db: DatabaseSync,
  client: GmailClient,
  config: GmailConfig,
  account: IngestAccount,
  options: SyncOptions = {}
) {
  return healthAwareSyncRunner(gate)(GMAIL_CONNECTOR, () =>
    syncGmail(db, client, config, account, options)
  )
}
