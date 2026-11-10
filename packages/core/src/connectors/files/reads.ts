import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { GateRequestError } from "@eido/gate"
import type { FileClient, IntentClient } from "@eido/gate"
import { validateGateLocalFileRequest } from "@eido/schemas"
import type { GateIntentOrigin } from "@eido/schemas"
import { createFilesWriteFacade } from "./facade"
import { checkRelativeFilePath, FileError } from "./path"
import { pdfText } from "./pdf"
import type { Parser } from "../../parsers/index"
import { ingestBatch } from "../../index/ingest"
import type { IndexedDocument, DocumentHeadChange } from "../../index/ingest"
import { search } from "../../index/search"
import { writeQueueFor } from "../../db/write-queue"
import type { FileRootSyncCursor } from "./notes"

const MAX_BYTES = 8 * 1024 * 1024
const SCAN_BYTES = 16 * 1024 * 1024
const TEXT = /\.(?:txt|md|markdown|csv|json|html?|log|ya?ml|ics)$/i

export function normalizeTextBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").normalize("NFC")
}

export function classifyFileMime(path: string): string {
  if (/\.(?:md|markdown)$/i.test(path)) return "text/markdown"
  if (/\.txt$/i.test(path)) return "text/plain"
  if (/\.csv$/i.test(path)) return "text/csv"
  if (/\.json$/i.test(path)) return "application/json"
  if (/\.(?:html|htm)$/i.test(path)) return "text/html"
  if (/\.ics$/i.test(path)) return "text/calendar"
  if (/\.(?:yaml|yml)$/i.test(path)) return "application/yaml"
  if (/\.log$/i.test(path)) return "text/x-log"
  if (/\.pdf$/i.test(path)) return "application/pdf"
  return "application/octet-stream"
}

export const fileSourceRef = (root: string, path: string) =>
  JSON.stringify([root, path])

function location(value: unknown): { root: string; path: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "root" && key !== "path")
  )
    throw new FileError("invalid_payload")
  const checked = validateGateLocalFileRequest({
    ...value,
    op: "read",
    maxBytes: MAX_BYTES,
  })
  if (!checked.ok || checked.value.op !== "read")
    throw new FileError("invalid_payload")
  checkRelativeFilePath(checked.value.path)
  return { root: checked.value.root, path: checked.value.path }
}

export type FilesDeps = {
  files: FileClient
  intents: Pick<IntentClient, "propose">
  db: DatabaseSync
  /**
   * The sandboxed parser PDFs are read through. Undefined only where the sandbox cannot run
   * (Windows): PDFs are then parsed in this process.
   */
  parser: Pick<Parser, "parseBytes"> | undefined
  origin?: GateIntentOrigin
  entityId?: () => Promise<string | undefined>
}
export function createFilesFacade({
  files,
  intents,
  db,
  parser,
  origin,
  entityId,
}: FilesDeps) {
  async function perform(request: Parameters<FileClient["perform"]>[0]) {
    try {
      const result = await files.perform(request)
      if (!result.ok) {
        if (["invalid_path", "symlink", "root_changed"].includes(result.code))
          throw new FileError("path_not_allowed")
        if (result.code === "not_found") throw new FileError("not_found")
        throw new FileError("read_failed")
      }
      return result
    } catch (error) {
      if (error instanceof GateRequestError) {
        if (error.status === 403) throw new FileError("path_not_allowed")
        if (error.status === 404) throw new FileError("not_found")
      }
      if (error instanceof FileError) throw error
      throw new FileError("read_failed")
    }
  }
  async function bytes(root: string, path: string, maxBytes = MAX_BYTES) {
    const result = await perform({ op: "read", root, path, maxBytes })
    if (result.op !== "read") throw new FileError("read_failed")
    const data = Buffer.from(result.contentBase64, "base64")
    if (
      data.byteLength > maxBytes ||
      data.toString("base64") !== result.contentBase64
    )
      throw new FileError("read_failed")
    return data
  }
  const text = (data: Uint8Array) => {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data)
      return normalizeTextBody(decoded)
    } catch {
      throw new FileError("invalid_text")
    }
  }
  async function write(
    verb: keyof ReturnType<typeof createFilesWriteFacade>,
    args: unknown
  ) {
    const roots = await files.roots()
    return createFilesWriteFacade({
      intents,
      rootIds: roots.roots.map(({ id }) => id),
      origin,
    })[verb](args)
  }
  async function performScan(root: string) {
    if (!(await files.roots()).roots.some(({ id }) => id === root))
      throw new FileError("path_not_allowed")
    const pending = [""]
    const documents: IndexedDocument[] = []
    const seen = new Set<string>()
    let dirs = 0,
      count = 0,
      budget = SCAN_BYTES,
      partial = false,
      skippedCount = 0
    const assigned = await entityId?.()
    while (pending.length > 0 && dirs < 128 && count < 1000) {
      const directory = pending.shift()
      if (directory === undefined) break
      dirs += 1
      let listed
      try {
        listed = await perform({ op: "list", root, path: directory })
      } catch (error) {
        if (directory === "") throw error
        partial = true
        skippedCount += 1
        continue
      }
      if (listed.op !== "list") throw new FileError("read_failed")
      if (listed.truncated) {
        partial = true
        skippedCount += 1
      }
      for (const entry of listed.entries) {
        if (count >= 1000) {
          partial = true
          skippedCount += 1
          break
        }
        const path =
          directory === "" ? entry.name : `${directory}/${entry.name}`
        try {
          checkRelativeFilePath(path)
        } catch {
          partial = true
          skippedCount += 1
          continue
        }
        if (entry.kind === "directory") {
          if (pending.length + dirs < 128) pending.push(path)
          else {
            partial = true
            skippedCount += 1
          }
          continue
        }
        count += 1
        const ref = fileSourceRef(root, path)
        seen.add(ref)
        let body = ""
        if (TEXT.test(path) || /\.pdf$/i.test(path)) {
          if (budget < 1) {
            partial = true
            skippedCount += 1
            continue
          }
          try {
            const data = await bytes(root, path, Math.min(MAX_BYTES, budget))
            budget -= data.byteLength
            body = /\.pdf$/i.test(path)
              ? normalizeTextBody(await pdfText(parser, data))
              : text(data)
          } catch {
            partial = true
            skippedCount += 1
            continue
          }
        }
        const mime = classifyFileMime(path)
        const sha256 = createHash("sha256")
          .update(JSON.stringify([root, path, body]))
          .digest("hex")
        documents.push({
          sha256,
          source: "files",
          sourceRef: ref,
          mime,
          title: path,
          body,
          ...(assigned === undefined ? {} : { entityId: assigned }),
        })
      }
    }
    if (pending.length > 0) {
      partial = true
      skippedCount += pending.length
    }
    const heads: DocumentHeadChange[] = documents.map((doc) => ({
      source: "files",
      sourceRef: doc.sourceRef,
      sha256: doc.sha256,
    }))
    // Never show old indexed content for a file whose current read failed. On an incomplete
    // walk, keep unseen heads: absence was not established for directories we could not scan.
    const old = db
      .prepare("SELECT source_ref FROM document_heads WHERE source='files'")
      .all()
    for (const row of old) {
      const ref = String(row["source_ref"])
      let parsed: unknown
      try {
        parsed = JSON.parse(ref)
      } catch {
        continue
      }
      if (!Array.isArray(parsed) || parsed[0] !== root) continue
      if (
        (!partial || seen.has(ref)) &&
        !documents.some((doc) => doc.sourceRef === ref)
      )
        heads.push({ source: "files", sourceRef: ref, sha256: null })
    }
    const indexedFiles = documents.length
    const noteCount = documents.filter(
      (doc) => doc.mime === "text/markdown" || doc.mime === "text/plain"
    ).length
    const cursor: FileRootSyncCursor = {
      partial,
      indexedFiles,
      noteCount,
      skippedCount,
    }
    await writeQueueFor(db).run(() =>
      ingestBatch(db, {
        connector: "files",
        stream: root,
        nextCursor: JSON.stringify(cursor),
        documents,
        heads,
      })
    )
    return {
      documents,
      coverage: partial ? ("partial" as const) : ("complete" as const),
      cursor,
    }
  }
  const scans = new Map<
    string,
    Promise<{
      documents: IndexedDocument[]
      coverage: "partial" | "complete"
      cursor: FileRootSyncCursor
    }>
  >()
  function scan(root: string) {
    const existing = scans.get(root)
    if (existing !== undefined) return existing
    const pending = performScan(root)
    scans.set(root, pending)
    const clear = () => {
      if (scans.get(root) === pending) scans.delete(root)
    }
    void pending.then(clear, clear)
    return pending
  }
  return {
    file_create: (args: unknown) => write("file_create", args),
    file_rename: (args: unknown) => write("file_rename", args),
    file_move: (args: unknown) => write("file_move", args),
    file_delete: (args: unknown) => write("file_delete", args),
    async file_read_text(args: unknown) {
      const { root, path } = location(args)
      return { text: text(await bytes(root, path)), untrusted: true as const }
    },
    async file_read_pdf_text(args: unknown) {
      const { root, path } = location(args)
      return {
        text: await pdfText(parser, await bytes(root, path)),
        untrusted: true as const,
      }
    },
    async files_search(query: string, { root }: { root: string }) {
      if (typeof query !== "string" || query.length > 2000)
        throw new FileError("invalid_payload")
      const scanned = await scan(root)
      const refs = new Map(scanned.documents.map((doc) => [doc.sourceRef, doc]))
      const indexed = search(db, {
        text: query,
        source: "files",
        limit: 1000,
        fuzzy: false,
      })
      const selected = new Set(
        indexed
          .filter((hit) => refs.has(hit.sourceRef))
          .map((hit) => hit.sourceRef)
      )
      for (const doc of scanned.documents)
        if (doc.title?.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          selected.add(doc.sourceRef)
      return {
        hits: scanned.documents
          .filter((doc) => selected.has(doc.sourceRef))
          .map((doc) => ({
            root,
            path: doc.title ?? "",
            sha256: doc.sha256,
            untrusted: true as const,
          })),
        coverage: scanned.coverage,
      }
    },
    sync: scan,
    roots: () => files.roots(),
  }
}
export type FilesFacade = ReturnType<typeof createFilesFacade>
