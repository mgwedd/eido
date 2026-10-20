import { GmailError, errorFromResponse } from "./errors"
import { asObject, objects, optionalString, strings } from "./json"
import type { JsonObject } from "./json"
import { GMAIL_HOST, READ_PATHS } from "./routes"
import type { GmailTransport } from "./transport"

// The Gmail API read client. It only reads: writes are built and sent by the gate's executor
// (packages/gate/src/internal/gmail-writers.ts) after an intent is approved or auto-tiered.

export type MessageRef = { id: string; threadId?: string }

export type MessagePage = { messages: MessageRef[]; nextPageToken?: string }

export type RawMessage = {
  id: string
  threadId?: string
  labelIds: string[]
  historyId?: string
  /** Milliseconds since the epoch, as Gmail reports it. */
  internalDate?: string
  /** The RFC 5322 bytes (`format=raw`), decoded from base64url. */
  raw: Uint8Array
}

export type Thread = {
  id: string
  historyId?: string
  messages: { id: string; labelIds: string[] }[]
}

export type HistoryPage = {
  /** Ids of messages added to the label, or given the label, in this page. */
  messageIds: string[]
  /** The mailbox's current history id. */
  historyId: string
  nextPageToken?: string
}

export type Profile = { emailAddress?: string; historyId: string }

function path(template: string, id?: string): string {
  return id === undefined
    ? template
    : template.replace("{id}", encodeURIComponent(id))
}

function required(object: JsonObject, key: string): string {
  const value = optionalString(object, key)
  if (value === undefined)
    throw new GmailError("invalid_response", `Gmail response lacks ${key}`)
  return value
}

function ref(object: JsonObject): MessageRef {
  const threadId = optionalString(object, "threadId")
  return {
    id: required(object, "id"),
    ...(threadId === undefined ? {} : { threadId }),
  }
}

export function createGmailClient(transport: GmailTransport) {
  async function get(
    template: string,
    id: string | undefined,
    query: Record<string, string | readonly string[] | undefined> = {}
  ): Promise<JsonObject> {
    const url = new URL(`https://${GMAIL_HOST}${path(template, id)}`)
    for (const [key, value] of Object.entries(query)) {
      for (const item of [value ?? []].flat())
        url.searchParams.append(key, item)
    }
    const response = await transport({ method: "GET", url: url.href })
    if (!response.ok) throw await errorFromResponse(response)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    const object = asObject(body)
    if (object === undefined)
      throw new GmailError("invalid_response", "Gmail answered with no object")
    return object
  }

  return {
    async getProfile(): Promise<Profile> {
      const body = await get(READ_PATHS.profile, undefined)
      const emailAddress = optionalString(body, "emailAddress")
      return {
        historyId: required(body, "historyId"),
        ...(emailAddress === undefined ? {} : { emailAddress }),
      }
    },

    async searchMessages(
      query: string,
      options: { limit: number; pageToken?: string; labelIds?: string[] }
    ): Promise<MessagePage> {
      const body = await get(READ_PATHS.messages, undefined, {
        q: query === "" ? undefined : query,
        maxResults: String(options.limit),
        pageToken: options.pageToken,
        labelIds: options.labelIds,
      })
      const nextPageToken = optionalString(body, "nextPageToken")
      return {
        messages: objects(body, "messages").map(ref),
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      }
    },

    async getThread(threadId: string): Promise<Thread> {
      const body = await get(READ_PATHS.thread, threadId, { format: "minimal" })
      const historyId = optionalString(body, "historyId")
      return {
        id: required(body, "id"),
        ...(historyId === undefined ? {} : { historyId }),
        messages: objects(body, "messages").map((m) => ({
          id: required(m, "id"),
          labelIds: strings(m, "labelIds"),
        })),
      }
    },

    async getMessage(id: string): Promise<RawMessage> {
      const body = await get(READ_PATHS.message, id, { format: "raw" })
      const threadId = optionalString(body, "threadId")
      const historyId = optionalString(body, "historyId")
      const internalDate = optionalString(body, "internalDate")
      return {
        id: required(body, "id"),
        ...(threadId === undefined ? {} : { threadId }),
        labelIds: strings(body, "labelIds"),
        ...(historyId === undefined ? {} : { historyId }),
        ...(internalDate === undefined ? {} : { internalDate }),
        raw: new Uint8Array(Buffer.from(required(body, "raw"), "base64url")),
      }
    },

    /**
     * Changes since `startHistoryId` for one label. Gmail answers 404 when that id is too old to
     * replay; that is reported as `history_expired` so the caller can resync.
     */
    async listHistory(
      startHistoryId: string,
      options: { labelId: string; limit: number; pageToken?: string }
    ): Promise<HistoryPage> {
      let body: JsonObject
      try {
        body = await get(READ_PATHS.history, undefined, {
          startHistoryId,
          labelId: options.labelId,
          historyTypes: ["messageAdded", "labelAdded"],
          maxResults: String(options.limit),
          pageToken: options.pageToken,
        })
      } catch (error) {
        if (error instanceof GmailError && error.code === "not_found")
          throw new GmailError(
            "history_expired",
            "the stored Gmail history id has expired",
            404
          )
        throw error
      }
      const ids = new Set<string>()
      for (const record of objects(body, "history")) {
        for (const added of objects(record, "messagesAdded")) {
          const message = asObject(added["message"])
          if (message !== undefined) ids.add(required(message, "id"))
        }
        for (const labelled of objects(record, "labelsAdded")) {
          const message = asObject(labelled["message"])
          if (
            message !== undefined &&
            strings(labelled, "labelIds").includes(options.labelId)
          )
            ids.add(required(message, "id"))
        }
      }
      const nextPageToken = optionalString(body, "nextPageToken")
      return {
        messageIds: [...ids],
        historyId: required(body, "historyId"),
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      }
    },
  }
}

export type GmailClient = ReturnType<typeof createGmailClient>
