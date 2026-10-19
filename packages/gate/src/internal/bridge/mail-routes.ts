import type { DatabaseSync } from "node:sqlite"
import type {
  GateMailFolderList,
  GateMailFolderState,
  GateMailMessagePage,
} from "@eido/schemas"
import { append } from "../audit"
import { payloadHash } from "../canonical"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"
import type { ProtonBridge } from "./bridge"
import { PROTON_CONNECTOR } from "./config"
import { imapError } from "./errors"

// The Proton mail read routes on the data-plane listener (#195). Core reads raw messages here
// and parses them itself; the gate never does. Each call writes one audit row whose detail hash
// covers counts only (folders, messages, skipped, bytes), never names, subjects or bodies.

/** The adapter reads these routes use. */
export type MailReads = Pick<
  ProtonBridge,
  "listFolders" | "folderState" | "fetchRaw"
>

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 100
/** Folders one listing returns at most (the schema's cap). */
export const MAX_FOLDERS = 1000
const MAX_UID = 4294967295

const FOLDERS_PATH = "/mail/proton/folders"
const FOLDER_PATH = /^\/mail\/proton\/folders\/([^/]+)\/(state|messages)$/

type Read = "folders" | "state" | "messages"

function audit(
  db: DatabaseSync,
  read: Read,
  outcome: string | undefined,
  counts: Readonly<Record<string, number>>
): void {
  append(db, {
    actor: "data-plane",
    action: `mail.read.${read}${outcome === undefined ? "" : `.${outcome}`}`,
    target: PROTON_CONNECTOR,
    detailHash: payloadHash(counts),
  })
}

function failed(db: DatabaseSync, read: Read, error: unknown): Reply {
  const mapped = imapError(error)
  audit(db, read, `failed.${mapped.code}`, {})
  if (mapped.code === "handshake_failed" || mapped.code === "auth_failed") {
    return apiError(502, mapped.code, mapped.message)
  }
  return apiError(500, "unavailable", "Bridge could not answer")
}

function invalid(db: DatabaseSync, read: Read, message: string): Reply {
  audit(db, read, "refused", {})
  return apiError(400, "invalid_request", message)
}

function missing(db: DatabaseSync, read: Read): Reply {
  audit(db, read, "not_found", {})
  return apiError(404, "not_found", "no such folder")
}

/** A whole number in [min, max] from a query value, or undefined. */
function integer(
  value: string | null,
  min: number,
  max: number
): number | undefined {
  if (value === null || !/^\d{1,10}$/.test(value)) return undefined
  const number = Number(value)
  return number >= min && number <= max ? number : undefined
}

async function folders(db: DatabaseSync, bridge: MailReads): Promise<Reply> {
  let listed: string[]
  try {
    listed = await bridge.listFolders()
  } catch (error) {
    return failed(db, "folders", error)
  }
  const body: GateMailFolderList = { folders: listed.slice(0, MAX_FOLDERS) }
  audit(db, "folders", undefined, { folders: body.folders.length })
  return { status: 200, body }
}

async function state(
  db: DatabaseSync,
  bridge: MailReads,
  folder: string
): Promise<Reply> {
  let found: Awaited<ReturnType<MailReads["folderState"]>>
  try {
    found = await bridge.folderState(folder)
  } catch (error) {
    return failed(db, "state", error)
  }
  if (found === undefined) return missing(db, "state")
  const body: GateMailFolderState = found
  audit(db, "state", undefined, { folders: 1 })
  return { status: 200, body }
}

async function messages(
  db: DatabaseSync,
  bridge: MailReads,
  folder: string,
  query: URLSearchParams
): Promise<Reply> {
  const fromUid = integer(query.get("fromUid"), 1, MAX_UID)
  const rawLimit = query.get("limit")
  const limit =
    rawLimit === null
      ? DEFAULT_PAGE_LIMIT
      : integer(rawLimit, 1, Number.MAX_SAFE_INTEGER)
  if (fromUid === undefined) {
    return invalid(db, "messages", "fromUid must be a UID from 1 to 4294967295")
  }
  if (limit === undefined)
    return invalid(db, "messages", "limit must be a whole number from 1")
  let page: Awaited<ReturnType<MailReads["fetchRaw"]>>
  try {
    page = await bridge.fetchRaw(
      folder,
      fromUid,
      Math.min(limit, MAX_PAGE_LIMIT)
    )
  } catch (error) {
    return failed(db, "messages", error)
  }
  if (page === undefined) return missing(db, "messages")
  const body: GateMailMessagePage = {
    messages: page.messages.map((message) => ({
      uid: message.uid,
      raw: message.raw.toString("base64"),
    })),
    skipped: page.skipped,
  }
  audit(db, "messages", undefined, {
    messages: page.messages.length,
    skipped: page.skipped.length,
    bytes: page.messages.reduce((sum, message) => sum + message.raw.length, 0),
  })
  return { status: 200, body }
}

/** The mail read routes, or undefined when the request is not one of them. */
export function mailRoute(
  request: GateRequest,
  db: DatabaseSync,
  bridge: MailReads
): Promise<Reply> | Reply | undefined {
  if (request.method !== "GET") return undefined
  if (request.path === FOLDERS_PATH) return folders(db, bridge)
  const match = FOLDER_PATH.exec(request.path)
  if (match === null) return undefined
  const read = match[2] === "state" ? "state" : "messages"
  let folder: string
  try {
    folder = decodeURIComponent(match[1] ?? "")
  } catch {
    return invalid(db, read, "the folder name is not valid percent-encoding")
  }
  return read === "state"
    ? state(db, bridge, folder)
    : messages(db, bridge, folder, request.query)
}
