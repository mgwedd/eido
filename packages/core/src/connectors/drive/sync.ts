import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { getCursor, ingestBatch } from "../../index/index"
import type { IndexedDocument } from "../../index/index"
import type { DocumentHeadChange } from "../../index/index"
import { ingestEntityId } from "../ingest-entity"
import { writeQueueFor } from "../../db/write-queue"
import type { IngestAccount } from "../ingest-entity"
import { DriveError } from "./client"
import type { DriveChange, DriveClient, DriveFile } from "./client"

type Cursor = { phase: "list" | "changes"; token: string; page?: string }
function cursor(raw: string): Cursor {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new DriveError("invalid_response")
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("phase" in value) ||
    !["list", "changes"].includes(String(value.phase)) ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    ("page" in value && typeof value.page !== "string")
  )
    throw new DriveError("invalid_response")
  return {
    phase: value.phase === "list" ? "list" : "changes",
    token: value.token,
    ...("page" in value && typeof value.page === "string"
      ? { page: value.page }
      : {}),
  }
}
/** A cursor and its documents commit in one transaction. The pre-list changes token closes the initial listing race. */
export async function syncDrive(options: {
  db: DatabaseSync
  client: DriveClient
  account: IngestAccount
}) {
  const entityId = await ingestEntityId("drive", options.account)
  const saved = getCursor(options.db, "drive", "files")
  let current: Cursor =
    saved === null
      ? { phase: "list", token: await options.client.startPageToken() }
      : cursor(saved.cursor)
  const commit = (
    documents: IndexedDocument[],
    heads: DocumentHeadChange[],
    next: Cursor
  ) =>
    writeQueueFor(options.db).run(() =>
      ingestBatch(options.db, {
        connector: "drive",
        stream: "files",
        documents,
        heads,
        nextCursor: JSON.stringify(next),
      })
    )
  if (saved === null) await commit([], [], current)
  let inserted = 0
  let skipped = 0
  for (;;) {
    let events: DriveChange[]
    let nextPageToken: string | undefined
    let newStartPageToken: string | undefined
    if (current.phase === "list") {
      const page = await options.client.listFiles(
        current.page === undefined ? {} : { pageToken: current.page }
      )
      events = page.files.map((file) => ({ kind: "upsert", file }))
      nextPageToken = page.nextPageToken
    } else {
      const page = await options.client.changes(current.token)
      events = page.changes
      nextPageToken = page.nextPageToken
      newStartPageToken = page.newStartPageToken
    }
    // A change page can mention the same file more than once. Only its final state
    // matters, and a removed file cannot be fetched after the removal.
    const latest = new Map<string, DriveChange>()
    for (const event of events) {
      const id = event.kind === "removed" ? event.fileId : event.file.id
      latest.delete(id)
      latest.set(id, event)
    }
    const documents: IndexedDocument[] = []
    const heads: DocumentHeadChange[] = []
    for (const event of latest.values()) {
      if (event.kind === "removed") {
        heads.push({ source: "drive", sourceRef: event.fileId, sha256: null })
        continue
      }
      const { file } = event
      if (!supported(file)) {
        skipped += 1
        heads.push({ source: "drive", sourceRef: file.id, sha256: null })
        continue
      }
      const content = await options.client.getFileText(file.id)
      const sha256 = createHash("sha256")
        .update(`${file.id}\0${file.name}\0${file.mimeType}\0${content.text}`)
        .digest("hex")
      documents.push({
        sha256,
        source: "drive",
        sourceRef: file.id,
        mime: file.mimeType,
        title: file.name,
        body: content.text,
        entityId,
      })
      heads.push({ source: "drive", sourceRef: file.id, sha256 })
    }
    let next: Cursor
    if (current.phase === "list")
      next =
        nextPageToken === undefined
          ? { phase: "changes", token: current.token }
          : { ...current, page: nextPageToken }
    else {
      const token = nextPageToken ?? newStartPageToken
      if (typeof token !== "string") throw new DriveError("invalid_response")
      next = { phase: "changes", token }
    }
    const result = await commit(documents, heads, next)
    inserted += result.inserted
    skipped += result.skipped
    const done = current.phase === "changes" && nextPageToken === undefined
    current = next
    if (done) return { inserted, skipped }
  }
}
function supported(file: DriveFile) {
  return (
    file.mimeType === "application/vnd.google-apps.document" ||
    file.mimeType === "application/pdf" ||
    file.mimeType.startsWith("text/")
  )
}
