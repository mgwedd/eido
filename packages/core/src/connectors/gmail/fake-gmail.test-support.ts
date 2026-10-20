import type { GmailRequest, GmailTransport } from "./transport"

// An in-memory Gmail API for tests, shaped like the real responses. Every address and id is
// synthetic (example.com); nothing here touches a network.

export type FakeMessage = {
  id: string
  threadId: string
  labelIds: string[]
  raw: string
  internalDate: string
}

type HistoryRecord = {
  id: number
  messageId: string
  kind: "messageAdded" | "labelAdded" | "labelRemoved"
  labelIds: string[]
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

/** A synthetic RFC 5322 message. Built for tests only; the connector parses with postal-mime. */
export function rfc822(fields: {
  messageId: string
  subject: string
  body: string
  from?: string
  to?: string
  date?: string
  attachment?: { filename: string; mime: string; content: string }
}): string {
  const head = [
    `From: ${fields.from ?? "Ada Sender <ada@example.com>"}`,
    `To: ${fields.to ?? "owner@example.com"}`,
    `Subject: ${fields.subject}`,
    `Date: ${fields.date ?? "Mon, 19 Oct 2026 09:00:00 +0000"}`,
    `Message-ID: <${fields.messageId}>`,
    "MIME-Version: 1.0",
  ]
  if (fields.attachment === undefined)
    return [
      ...head,
      "Content-Type: text/plain; charset=utf-8",
      "",
      fields.body,
      "",
    ].join("\r\n")
  const a = fields.attachment
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    fields.body,
    "--b1",
    `Content-Type: ${a.mime}; name="${a.filename}"`,
    `Content-Disposition: attachment; filename="${a.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(a.content).toString("base64"),
    "--b1--",
    "",
  ].join("\r\n")
}

export function createFakeGmail() {
  const messages: FakeMessage[] = []
  const history: HistoryRecord[] = []
  const requests: GmailRequest[] = []
  let historyId = 1000
  /** History ids at or below this one are too old to replay (Gmail answers 404). */
  let oldestHistoryId = 0
  let failures: {
    when: (url: URL) => boolean
    response: () => Response
  }[] = []

  function add(
    message: Omit<FakeMessage, "internalDate"> & { internalDate?: string }
  ) {
    historyId += 1
    // Gmail lists newest first.
    messages.unshift({
      internalDate: String(Date.UTC(2026, 9, 19) + historyId),
      ...message,
    })
    history.push({
      id: historyId,
      messageId: message.id,
      kind: "messageAdded",
      labelIds: message.labelIds,
    })
  }

  function addLabel(id: string, label: string) {
    const message = messages.find((m) => m.id === id)
    if (message === undefined) throw new Error(`no message ${id}`)
    historyId += 1
    message.labelIds.push(label)
    history.push({
      id: historyId,
      messageId: id,
      kind: "labelAdded",
      labelIds: [label],
    })
  }

  /** Removes a label, as marking read (UNREAD) or archiving (INBOX) does. */
  function removeLabel(id: string, label: string) {
    const message = messages.find((m) => m.id === id)
    if (message === undefined) throw new Error(`no message ${id}`)
    historyId += 1
    message.labelIds = message.labelIds.filter((l) => l !== label)
    history.push({
      id: historyId,
      messageId: id,
      kind: "labelRemoved",
      labelIds: [label],
    })
  }

  function page<T>(items: T[], url: URL): { slice: T[]; next?: string } {
    const size = Number(url.searchParams.get("maxResults") ?? "100")
    const start = Number(url.searchParams.get("pageToken") ?? "0")
    const slice = items.slice(start, start + size)
    return start + size < items.length
      ? { slice, next: String(start + size) }
      : { slice }
  }

  function answer(url: URL): Response {
    const path = url.pathname.replace("/gmail/v1/users/me", "")
    if (path === "/profile")
      return json(200, {
        emailAddress: "owner@example.com",
        historyId: String(historyId),
      })
    if (path === "/messages") {
      const label = url.searchParams.get("labelIds")
      const listed = messages.filter(
        (m) => label === null || m.labelIds.includes(label)
      )
      const { slice, next } = page(listed, url)
      return json(200, {
        messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })),
        resultSizeEstimate: listed.length,
        ...(next === undefined ? {} : { nextPageToken: next }),
      })
    }
    const message = /^\/messages\/([^/]+)$/.exec(path)
    if (message !== null) {
      const found = messages.find((m) => m.id === message[1])
      if (found === undefined) return json(404, { error: { code: 404 } })
      return json(200, {
        id: found.id,
        threadId: found.threadId,
        labelIds: found.labelIds,
        historyId: String(historyId),
        internalDate: found.internalDate,
        raw: Buffer.from(found.raw).toString("base64url"),
      })
    }
    const thread = /^\/threads\/([^/]+)$/.exec(path)
    if (thread !== null) {
      const members = messages.filter((m) => m.threadId === thread[1])
      if (members.length === 0) return json(404, { error: { code: 404 } })
      return json(200, {
        id: thread[1],
        historyId: String(historyId),
        messages: members.map((m) => ({ id: m.id, labelIds: m.labelIds })),
      })
    }
    if (path === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"))
      if (start <= oldestHistoryId) return json(404, { error: { code: 404 } })
      const label = url.searchParams.get("labelId")
      const types = url.searchParams.getAll("historyTypes")
      const records = history.filter(
        (h) =>
          h.id > start &&
          types.includes(h.kind) &&
          (label === null || h.labelIds.includes(label))
      )
      const { slice, next } = page(records, url)
      return json(200, {
        history: slice.map((h) => ({
          id: String(h.id),
          ...(h.kind === "messageAdded"
            ? {
                messagesAdded: [
                  { message: { id: h.messageId, labelIds: h.labelIds } },
                ],
              }
            : {
                [h.kind === "labelAdded" ? "labelsAdded" : "labelsRemoved"]: [
                  { message: { id: h.messageId }, labelIds: h.labelIds },
                ],
              }),
        })),
        historyId: String(historyId),
        ...(next === undefined ? {} : { nextPageToken: next }),
      })
    }
    return json(400, { error: { code: 400, message: "unknown path" } })
  }

  const transport: GmailTransport = (request) => {
    requests.push(request)
    const url = new URL(request.url)
    const failure = failures.find((f) => f.when(url))
    if (failure !== undefined) {
      failures = failures.filter((f) => f !== failure)
      return Promise.resolve(failure.response())
    }
    return Promise.resolve(answer(url))
  }

  return {
    transport,
    requests,
    add,
    addLabel,
    removeLabel,
    /** Makes every history id up to now too old to replay. */
    expireHistory: () => {
      oldestHistoryId = historyId
    },
    /** Answers the next request matching `when` with `response` instead. */
    failOnce: (when: (url: URL) => boolean, response: () => Response) => {
      failures.push({ when, response })
    },
    get historyId() {
      return String(historyId)
    },
  }
}

export type FakeGmail = ReturnType<typeof createFakeGmail>

/** Adds `count` synthetic INBOX messages, ids gm-001 upward, each its own thread. */
export function seedInbox(gmail: FakeGmail, count: number, from = 1): void {
  for (let n = from; n < from + count; n++) {
    const id = `gm-${String(n).padStart(3, "0")}`
    gmail.add({
      id,
      threadId: `th-${id}`,
      labelIds: ["INBOX", "UNREAD"],
      raw: rfc822({
        messageId: `${id}@mail.example.com`,
        subject: `Lorem ipsum ${n}`,
        body: `Dolor sit amet number ${n}.`,
      }),
    })
  }
}
