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
import {
  beginConnectorRead,
  disableConnectorAfterAuthFailure,
  recordConnectorReadFailure,
  recordConnectorReadSuccess,
  releaseConnectorProbe,
} from "../connector-health"

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
/** How long core is told to wait before asking again after a busy refusal. */
export const BUSY_RETRY_AFTER_SECONDS = 5

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
  if (mapped.code === "busy") {
    // The gate's own limit on concurrent reads (#219): 503 with Retry-After, so core waits
    // and asks again later rather than looping. The code is `busy`, distinct from a Bridge failure.
    return {
      ...apiError(503, "busy", "the gate is busy reading mail"),
      headers: { "retry-after": String(BUSY_RETRY_AFTER_SECONDS) },
    }
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
): Promise<Reply> | undefined {
  if (request.method !== "GET") return undefined
  const match =
    request.path === FOLDERS_PATH ? undefined : FOLDER_PATH.exec(request.path)
  if (request.path !== FOLDERS_PATH && match === null) return undefined
  const read =
    request.path === FOLDERS_PATH
      ? "folders"
      : match?.[2] === "state"
        ? "state"
        : "messages"
  let folder: string | undefined
  if (match !== null && match !== undefined) {
    try {
      folder = decodeURIComponent(match[1] ?? "")
    } catch {
      return Promise.resolve(
        invalid(db, read, "the folder name is not valid percent-encoding")
      )
    }
  }
  if (read === "messages") {
    const fromUid = integer(request.query.get("fromUid"), 1, MAX_UID)
    const rawLimit = request.query.get("limit")
    const limit =
      rawLimit === null
        ? DEFAULT_PAGE_LIMIT
        : integer(rawLimit, 1, Number.MAX_SAFE_INTEGER)
    if (fromUid === undefined)
      return Promise.resolve(
        invalid(db, "messages", "fromUid must be a UID from 1 to 4294967295")
      )
    if (limit === undefined)
      return Promise.resolve(
        invalid(db, "messages", "limit must be a whole number from 1")
      )
  }
  const attempt = beginConnectorRead(db, PROTON_CONNECTOR)
  if (!attempt.allowed) {
    const reason = attempt.reason ?? "connector_open"
    audit(db, read, `refused.${reason}`, {})
    return Promise.resolve(
      apiError(
        503,
        "unavailable",
        reason === "connector_disabled"
          ? "connector is disabled"
          : "connector is waiting for its next read probe"
      )
    )
  }
  const operation =
    request.path === FOLDERS_PATH
      ? folders(db, bridge)
      : read === "state"
        ? state(db, bridge, folder ?? "")
        : messages(db, bridge, folder ?? "", request.query)
  return operation
    .then((reply) => {
      const code =
        typeof reply.body === "object" &&
        reply.body !== null &&
        "code" in reply.body
          ? reply.body.code
          : undefined
      if (reply.status === 200) {
        recordConnectorReadSuccess(db, PROTON_CONNECTOR, attempt)
      } else if (code === "handshake_failed") {
        recordConnectorReadFailure(
          db,
          PROTON_CONNECTOR,
          "handshake_failed",
          attempt
        )
      } else if (code === "auth_failed") {
        disableConnectorAfterAuthFailure(db, PROTON_CONNECTOR)
      } else if (code === "busy") {
        if (attempt.probe) releaseConnectorProbe(db, PROTON_CONNECTOR, attempt)
      } else if (attempt.probe) {
        recordConnectorReadFailure(db, PROTON_CONNECTOR, "unavailable", attempt)
      }
      return reply
    })
    .catch(() => {
      if (attempt.probe) {
        recordConnectorReadFailure(db, PROTON_CONNECTOR, "unavailable", attempt)
      }
      return apiError(500, "unavailable", "Bridge could not answer")
    })
}
