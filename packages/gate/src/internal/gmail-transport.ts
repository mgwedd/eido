import type { DatabaseSync } from "node:sqlite"
import { GMAIL_HOST, gmailMarkReadWriter } from "./gmail-writers"
import { getPinnedManifest } from "./connectors"
import type { UpstreamResult, WriteRequest, WriteTransport } from "./executor"
import type { Vault } from "./vault/vault"

// The gate's Gmail write transport. It sends the executor's already-validated writes with the
// compose client's (gmail.modify) credential, and for mark read it first reports each message's
// prior unread state, which batchModify's empty answer cannot give (#223).

/** Pinned shape of the one read this transport makes: users.messages.get, labels only. */
const MESSAGE_PATH_PATTERN = "/gmail/v1/users/me/messages/{id}"
const UNREAD = "UNREAD"

type Options = {
  db: DatabaseSync
  vault: Vault
  fetch?: typeof fetch
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The message read URL, built from a route the connector's pinned manifest declares on a read
 * operation. Never from the request: an unpinned or disabled connector has no route and fails.
 */
function messageReadUrl(
  db: DatabaseSync,
  connector: string,
  messageId: string
): string {
  const manifest = getPinnedManifest(db, connector)
  const pinned = (manifest?.operations ?? []).some(
    (operation) =>
      operation.effect === "read" &&
      (operation.routes ?? []).some(
        (route) =>
          route.host === GMAIL_HOST &&
          route.method === "GET" &&
          route.pathPattern === MESSAGE_PATH_PATTERN
      )
  )
  const hostAllowed = (manifest?.egress.hosts ?? []).some(
    (entry) =>
      entry.host === GMAIL_HOST &&
      entry.methods.some((method) => method === "GET") &&
      entry.pathPrefixes.some((prefix) =>
        MESSAGE_PATH_PATTERN.startsWith(prefix)
      )
  )
  if (!pinned || !hostAllowed) throw new Error("unpinned message read route")
  const path = MESSAGE_PATH_PATTERN.replace(
    "{id}",
    encodeURIComponent(messageId)
  )
  return `https://${GMAIL_HOST}${path}?format=minimal`
}

async function call(
  send: typeof fetch,
  url: string,
  token: string,
  init: { method: string; body?: string }
): Promise<Response> {
  const response = await send(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
    redirect: "manual",
  })
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error(`gmail ${init.method} failed with ${response.status}`)
  }
  return response
}

async function unreadBefore(
  send: typeof fetch,
  db: DatabaseSync,
  connector: string,
  token: string,
  messageIds: readonly string[]
): Promise<string[]> {
  const unread: string[] = []
  for (const id of messageIds) {
    const response = await call(
      send,
      messageReadUrl(db, connector, id),
      token,
      {
        method: "GET",
      }
    )
    const message: unknown = await response.json()
    const labels = isRecord(message) ? message["labelIds"] : undefined
    // A message with no labels has no labelIds field; anything else must be a label list.
    if (labels === undefined) continue
    if (
      !Array.isArray(labels) ||
      !labels.every((label) => typeof label === "string")
    )
      throw new Error("unreadable message labels")
    if (labels.includes(UNREAD)) unread.push(id)
  }
  return unread
}

export function gmailWriteTransport(options: Options): WriteTransport {
  const { db, vault } = options
  const send = options.fetch ?? fetch
  return async (request: WriteRequest): Promise<UpstreamResult> => {
    const body: unknown = JSON.parse(request.body)
    if (request.intentKind !== "email.markRead")
      throw new Error("no Gmail write adapter for this intent kind")
    const token = await vault.get({
      connector: request.connector,
      kind: "access_token",
      client: "write",
    })
    if (token === undefined) throw new Error("credential missing")
    // Re-derive the ids from the exact request the executor approved, then read their labels
    // through the pinned read route before changing them.
    const intent = gmailMarkReadWriter.intentFromRequest({
      method: request.method,
      url: request.url,
      body,
    })
    if (
      !isRecord(intent) ||
      !isRecord(intent["args"]) ||
      !Array.isArray(intent["args"]["messageIds"])
    )
      throw new Error("not a Gmail mark read request")
    const ids = intent["args"]["messageIds"].map(String)
    const previouslyUnread = await unreadBefore(
      send,
      db,
      request.connector,
      token,
      ids
    )
    await call(send, request.url, token, {
      method: request.method,
      body: request.body,
    })
    return { upstreamRef: null, result: { previouslyUnread } }
  }
}
