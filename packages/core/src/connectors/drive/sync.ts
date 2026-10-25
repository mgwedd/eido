import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { getCursor, ingestBatch } from "../../index/index"
import type { IndexedDocument } from "../../index/index"
import { ingestEntityId } from "../ingest-entity"
import type { IngestAccount } from "../ingest-entity"
import { DriveError } from "./client"
import type { DriveClient, DriveFile } from "./client"

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
  const commit = (documents: IndexedDocument[], next: Cursor) =>
    ingestBatch(options.db, {
      connector: "drive",
      stream: "files",
      documents,
      nextCursor: JSON.stringify(next),
    })
  if (saved === null) commit([], current)
  let inserted = 0
  let skipped = 0
  for (;;) {
    const page =
      current.phase === "list"
        ? await options.client.listFiles(
            current.page === undefined ? {} : { pageToken: current.page }
          )
        : await options.client.changes(current.token)
    const documents: IndexedDocument[] = []
    for (const file of page.files) {
      if (!supported(file)) {
        skipped += 1
        continue
      }
      const content = await options.client.getFileText(file.id)
      documents.push({
        sha256: createHash("sha256")
          .update(`${file.id}\0${content.text}`)
          .digest("hex"),
        source: "drive",
        sourceRef: file.id,
        mime: file.mimeType,
        title: file.name,
        body: content.text,
        entityId,
      })
    }
    let next: Cursor
    if (current.phase === "list")
      next =
        page.nextPageToken === undefined
          ? { phase: "changes", token: current.token }
          : { ...current, page: page.nextPageToken }
    else {
      const token =
        page.nextPageToken ??
        ("newStartPageToken" in page ? page.newStartPageToken : undefined)
      if (typeof token !== "string") throw new DriveError("invalid_response")
      next = { phase: "changes", token }
    }
    const result = commit(documents, next)
    inserted += result.inserted
    skipped += result.skipped
    const done = current.phase === "changes" && page.nextPageToken === undefined
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
