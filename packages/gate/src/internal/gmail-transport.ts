import type { DatabaseSync } from "node:sqlite"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import { GMAIL_HOST, GMAIL_WRITERS } from "./gmail-writers"
import { getPinnedManifest } from "./connectors"
import type { UpstreamResult, WriteRequest, WriteTransport } from "./executor"
import { authorizedCall } from "./vault/authorized-call"
import type { RefreshResult } from "./vault/authorized-call"
import type { Vault } from "./vault/vault"

// The gate's Gmail write transport. It sends the executor's already-validated writes with the
// compose client's (gmail.modify) credential. Before a reversible label change (mark read, label,
// archive) it reads each message's labels, which batchModify's empty answer cannot give (#223),
// and reports them in the result so the writer can build the undo.

/** Pinned shape of the one read this transport makes: users.messages.get, labels only. */
const MESSAGE_PATH_PATTERN = "/gmail/v1/users/me/messages/{id}"
const UNREAD = "UNREAD"

type Options = {
  db: DatabaseSync
  vault: Vault
  fetch?: typeof fetch
  clientId?: string
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
  options: Options,
  url: string,
  connector: string,
  init: { method: string; body?: string }
): Promise<Response> {
  const send = options.fetch ?? fetch
  const response = await authorizedCall({
    connector,
    client: "write",
    vault: options.vault,
    connectors: {
      isEnabled: (name) =>
        Promise.resolve(
          options.db
            .prepare("SELECT enabled FROM connectors WHERE name=?")
            .get(name)?.["enabled"] === 1
        ),
      disable: (name) => {
        options.db
          .prepare(
            "UPDATE connectors SET enabled=0, health='open' WHERE name=?"
          )
          .run(name)
        return Promise.resolve()
      },
    },
    audit: {
      append: (entry) => {
        append(options.db, {
          actor: "gate",
          action: entry.action,
          target: entry.target,
          detailHash: payloadHash({ errorClass: entry.errorClass }),
        })
        return Promise.resolve()
      },
    },
    refresh: (refreshToken) => refresh(options, connector, refreshToken),
    call: async (token) => {
      const upstream = await send(url, {
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
      if (upstream.status === 401)
        void upstream.body?.cancel().catch(() => undefined)
      return upstream
    },
  })
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error(`gmail ${init.method} failed with ${response.status}`)
  }
  return response
}

async function refresh(
  options: Options,
  connector: string,
  refreshToken: string
): Promise<RefreshResult> {
  const clientSecret = await options.vault.get({
    connector,
    kind: "api_key",
    client: "write",
  })
  if (!options.clientId || !clientSecret)
    return { ok: false, error: "temporarily_unavailable" }
  const response = await (options.fetch ?? fetch)(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      redirect: "manual",
    }
  )
  const value: unknown = await response.json().catch(() => undefined)
  if (
    response.status === 400 &&
    isRecord(value) &&
    value["error"] === "invalid_grant"
  )
    return { ok: false, error: "invalid_grant" }
  if (
    !response.ok ||
    !isRecord(value) ||
    typeof value["access_token"] !== "string"
  )
    return { ok: false, error: "temporarily_unavailable" }
  return { ok: true, accessToken: value["access_token"] }
}

/** Each message's labels before the write, read through the pinned messages.get route. */
async function labelsBefore(
  options: Options,
  connector: string,
  messageIds: readonly string[]
): Promise<Record<string, string[]>> {
  const prior: Record<string, string[]> = {}
  for (const id of messageIds) {
    const response = await call(
      options,
      messageReadUrl(options.db, connector, id),
      connector,
      { method: "GET" }
    )
    const message: unknown = await response.json()
    const labels = isRecord(message) ? message["labelIds"] : undefined
    // A message with no labels has no labelIds field; anything else must be a label list.
    if (
      labels !== undefined &&
      (!Array.isArray(labels) ||
        !labels.every((label) => typeof label === "string"))
    )
      throw new Error("unreadable message labels")
    prior[id] = labels ?? []
  }
  return prior
}

/** The message ids of a Gmail write, re-derived from the exact request the executor approved. */
function requestedIds(request: WriteRequest): string[] {
  const writer = GMAIL_WRITERS.find(
    (candidate) => candidate.kind === request.intentKind
  )
  if (writer === undefined)
    throw new Error("no Gmail write adapter for this intent kind")
  const intent = writer.intentFromRequest(
    {
      method: request.method,
      url: request.url,
      body: JSON.parse(request.body),
    },
    request.connector
  )
  const args = isRecord(intent) ? intent["args"] : undefined
  const ids = isRecord(args) ? args["messageIds"] : undefined
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
    throw new Error("not a Gmail batchModify request")
  return ids
}

export function gmailWriteTransport(options: Options): WriteTransport {
  return async (request: WriteRequest): Promise<UpstreamResult> => {
    const ids = requestedIds(request)
    const write = () =>
      call(options, request.url, request.connector, {
        method: request.method,
        body: request.body,
      })
    switch (request.intentKind) {
      case "email.markRead": {
        const prior = await labelsBefore(options, request.connector, ids)
        await write()
        const previouslyUnread = ids.filter((id) => prior[id]?.includes(UNREAD))
        return { upstreamRef: null, result: { previouslyUnread } }
      }
      case "email.label":
      case "email.archive": {
        const priorLabels = await labelsBefore(options, request.connector, ids)
        await write()
        return { upstreamRef: null, result: { priorLabels } }
      }
      default:
        // Trash: approval tier, so no undo is recorded and no prior state is read.
        await write()
        return { upstreamRef: null, result: {} }
    }
  }
}
