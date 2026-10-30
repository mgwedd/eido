import type { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import MailComposer from "nodemailer/lib/mail-composer"
import { simpleParser } from "mailparser"
import { validateIntent } from "@eido/schemas"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import { GMAIL_HOST, GMAIL_SEND_PATH, GMAIL_WRITERS } from "./gmail-writers"
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
const PROFILE_PATH_PATTERN = "/gmail/v1/users/me/profile"
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
  messageId: string,
  format: "minimal" | "raw" = "minimal"
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
  return `https://${GMAIL_HOST}${path}?format=${format}`
}

function profileReadUrl(db: DatabaseSync, connector: string): string {
  const manifest = getPinnedManifest(db, connector)
  const pinned = (manifest?.operations ?? []).some(
    (operation) =>
      operation.effect === "read" &&
      (operation.routes ?? []).some(
        (route) =>
          route.host === GMAIL_HOST &&
          route.method === "GET" &&
          route.pathPattern === PROFILE_PATH_PATTERN
      )
  )
  const hostAllowed = (manifest?.egress.hosts ?? []).some(
    (entry) =>
      entry.host === GMAIL_HOST &&
      entry.methods.includes("GET") &&
      entry.pathPrefixes.some((prefix) =>
        PROFILE_PATH_PATTERN.startsWith(prefix)
      )
  )
  if (!pinned || !hostAllowed) throw new Error("unpinned Gmail profile route")
  return `https://${GMAIL_HOST}${PROFILE_PATH_PATTERN}`
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
            `UPDATE connectors SET enabled=0, health='open', last_error='auth_failed',
               next_attempt_at=NULL, probe_started_at=NULL, probe_lease_id=NULL,
               health_generation=health_generation + 1 WHERE name=?`
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
async function requestedIds(request: WriteRequest): Promise<string[]> {
  const writer = GMAIL_WRITERS.find(
    (candidate) => candidate.kind === request.intentKind
  )
  if (writer === undefined)
    throw new Error("no Gmail write adapter for this intent kind")
  const intent = await writer.intentFromRequest(
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

async function sendMail(
  options: Options,
  request: WriteRequest
): Promise<UpstreamResult> {
  const writer = GMAIL_WRITERS.find(
    (candidate) => candidate.kind === request.intentKind
  )
  if (writer === undefined)
    throw new Error("no Gmail write adapter for this intent kind")
  const decoded = await writer.intentFromRequest(
    {
      method: request.method,
      url: request.url,
      body: JSON.parse(request.body),
    },
    request.connector
  )
  const checked = validateIntent(decoded)
  if (
    !checked.ok ||
    (checked.value.kind !== "email.draft" &&
      checked.value.kind !== "email.send")
  )
    throw new Error("not a Gmail mail write")
  const args = checked.value.args
  const profileResponse = await call(
    options,
    profileReadUrl(options.db, request.connector),
    request.connector,
    { method: "GET" }
  )
  const profile: unknown = await profileResponse.json()
  const emailAddress = isRecord(profile) ? profile["emailAddress"] : undefined
  if (typeof emailAddress !== "string" || emailAddress.length === 0)
    throw new Error("Gmail profile has no sender identity")
  const composer = new MailComposer({
    from: emailAddress,
    to: args.to,
    ...(args.cc === undefined ? {} : { cc: args.cc }),
    ...(args.bcc === undefined ? {} : { bcc: args.bcc }),
    subject: args.subject,
    text: args.body,
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile()
  composer.keepBcc = true
  const mime = await composer.build()
  const raw = Buffer.from(mime).toString("base64url")
  const isDraft = checked.value.kind === "email.draft"
  const draftId =
    checked.value.kind === "email.send" ? checked.value.args.draftId : undefined
  const path = isDraft
    ? "/gmail/v1/users/me/drafts"
    : draftId === undefined
      ? "/gmail/v1/users/me/messages/send"
      : "/gmail/v1/users/me/drafts/send"
  const body = isDraft
    ? { message: { raw } }
    : draftId === undefined
      ? { raw }
      : { id: draftId, message: { raw } }
  const response = await call(
    options,
    `https://${GMAIL_HOST}${path}`,
    request.connector,
    { method: "POST", body: JSON.stringify(body) }
  )
  const result: unknown = await response.json()
  if (!isRecord(result) || typeof result["id"] !== "string")
    throw new Error("Gmail response has no message id")
  const createdDraftId = isDraft ? result["id"] : undefined
  return {
    upstreamRef: createdDraftId ?? result["id"],
    result: {
      id: result["id"],
      ...(createdDraftId === undefined
        ? {}
        : {
            messageId: isRecord(result["message"])
              ? result["message"]["id"]
              : undefined,
          }),
    },
  }
}

type OriginalMessage = { raw: Buffer; threadId?: string }

async function originalMessage(
  options: Options,
  connector: string,
  messageId: string,
  expectedSha256: string
): Promise<OriginalMessage> {
  const response = await call(
    options,
    messageReadUrl(options.db, connector, messageId, "raw"),
    connector,
    { method: "GET" }
  )
  const value: unknown = await response.json()
  const raw = isRecord(value) ? value["raw"] : undefined
  const id = isRecord(value) ? value["id"] : undefined
  const threadId = isRecord(value) ? value["threadId"] : undefined
  if (
    typeof raw !== "string" ||
    typeof id !== "string" ||
    id !== messageId ||
    (threadId !== undefined && typeof threadId !== "string")
  )
    throw new Error("Gmail original message response is invalid")
  const bytes = Buffer.from(raw, "base64url")
  const hash = createHash("sha256").update(bytes).digest("hex")
  if (hash !== expectedSha256)
    throw new Error("Gmail original message changed after approval")
  return { raw: bytes, ...(threadId === undefined ? {} : { threadId }) }
}

async function authenticatedSender(
  options: Options,
  connector: string
): Promise<string> {
  const response = await call(
    options,
    profileReadUrl(options.db, connector),
    connector,
    { method: "GET" }
  )
  const profile: unknown = await response.json()
  const emailAddress = isRecord(profile) ? profile["emailAddress"] : undefined
  if (typeof emailAddress !== "string" || emailAddress.length === 0)
    throw new Error("Gmail profile has no sender identity")
  return emailAddress
}

type ParsedAddress = { address?: string }
type ParsedAddresses = { value: ParsedAddress[] }
function addressList(
  value: ParsedAddresses | ParsedAddresses[] | undefined
): string[] {
  const groups =
    value === undefined ? [] : Array.isArray(value) ? value : [value]
  return groups.flatMap((group) =>
    group.value.flatMap((entry) => (entry.address ? [entry.address] : []))
  )
}

function replyRecipients(
  original: Awaited<ReturnType<typeof simpleParser>>,
  identity: string,
  replyAll: boolean
): { to: string[]; cc: string[] } {
  const normalizedIdentity = identity.toLocaleLowerCase()
  const seen = new Set([normalizedIdentity])
  const unique = (items: readonly string[]) =>
    items.filter((item) => {
      const key = item.toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const replyTo = addressList(original.replyTo)
  const to = unique(replyTo.length > 0 ? replyTo : addressList(original.from))
  if (!replyAll) return { to, cc: [] }
  const cc = unique([...addressList(original.to), ...addressList(original.cc)])
  return to.length === 0 ? { to: cc, cc: [] } : { to, cc }
}

function sameRecipients(
  left: readonly string[],
  right: readonly string[]
): boolean {
  const a = [...new Set(left.map((item) => item.toLocaleLowerCase()))].sort()
  const b = [...new Set(right.map((item) => item.toLocaleLowerCase()))].sort()
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function headerText(
  mail: Awaited<ReturnType<typeof simpleParser>>,
  key: string
): string | undefined {
  const value = mail.headers.get(key)
  return typeof value === "string" ? value : undefined
}

function referencesText(
  mail: Awaited<ReturnType<typeof simpleParser>>
): string {
  const value = mail.headers.get("references")
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .filter((part): part is string => typeof part === "string")
      .join(" ")
  return ""
}

function prefixedSubject(
  prefix: "Re" | "Fwd",
  subject: string | undefined
): string {
  const value = (subject ?? "").trim()
  const already = prefix === "Re" ? /^re:/i : /^(fwd?|fw):/i
  return already.test(value) ? value : `${prefix}: ${value}`.trim()
}

async function sendReplyOrForward(
  options: Options,
  request: WriteRequest
): Promise<UpstreamResult> {
  // The executor request is an internal, hash-checked intent envelope. Decode it here, then
  // project only approved recipient/body fields plus source-derived thread metadata into Gmail's
  // raw MIME API request; the envelope itself is never sent upstream.
  const writer = GMAIL_WRITERS.find(
    (candidate) => candidate.kind === request.intentKind
  )
  if (writer === undefined) throw new Error("no Gmail reply or forward writer")
  const decoded = await writer.intentFromRequest(
    {
      method: request.method,
      url: request.url,
      body: JSON.parse(request.body),
    },
    request.connector
  )
  const checked = validateIntent(decoded)
  if (
    !checked.ok ||
    (checked.value.kind !== "email.reply" &&
      checked.value.kind !== "email.forward")
  )
    throw new Error("not a Gmail reply or forward")
  const original = await originalMessage(
    options,
    request.connector,
    checked.value.args.messageId,
    checked.value.args.messageSha256
  )
  const parsed = await simpleParser(original.raw)
  const from = await authenticatedSender(options, request.connector)
  let mime: Buffer
  let body: { raw: string; threadId?: string }
  if (checked.value.kind === "email.reply") {
    const args = checked.value.args
    if (!original.threadId)
      throw new Error("Gmail original message has no thread id")
    const recipients = replyRecipients(parsed, from, args.replyAll)
    if (
      !sameRecipients(recipients.to, args.to) ||
      !sameRecipients(recipients.cc, args.cc ?? [])
    )
      throw new Error(
        "Gmail reply recipients differ from the approved recipients"
      )
    const messageId = headerText(parsed, "message-id")
    const priorReferences = referencesText(parsed)
    const references = [priorReferences, messageId].filter(Boolean).join(" ")
    const composer = new MailComposer({
      from,
      to: args.to,
      ...(args.cc === undefined ? {} : { cc: args.cc }),
      subject: prefixedSubject("Re", parsed.subject),
      text: args.body,
      ...(messageId === undefined ? {} : { inReplyTo: messageId }),
      ...(references === "" ? {} : { references }),
      disableFileAccess: true,
      disableUrlAccess: true,
    }).compile()
    mime = await composer.build()
    body = {
      raw: Buffer.from(mime).toString("base64url"),
      threadId: original.threadId,
    }
  } else {
    const args = checked.value.args
    const composer = new MailComposer({
      from,
      to: args.to,
      subject: prefixedSubject("Fwd", parsed.subject),
      text: args.note ?? "",
      attachments: [
        {
          filename: "forwarded.eml",
          content: original.raw,
          contentType: "message/rfc822",
        },
      ],
      disableFileAccess: true,
      disableUrlAccess: true,
    }).compile()
    mime = await composer.build()
    body = { raw: Buffer.from(mime).toString("base64url") }
  }
  const response = await call(
    options,
    `https://${GMAIL_HOST}${GMAIL_SEND_PATH}`,
    request.connector,
    { method: "POST", body: JSON.stringify(body) }
  )
  const result: unknown = await response.json()
  if (!isRecord(result) || typeof result["id"] !== "string")
    throw new Error("Gmail response has no message id")
  return { upstreamRef: result["id"], result: { id: result["id"] } }
}

export function gmailWriteTransport(options: Options): WriteTransport {
  return async (request: WriteRequest): Promise<UpstreamResult> => {
    if (
      request.intentKind === "email.draft" ||
      request.intentKind === "email.send"
    )
      return sendMail(options, request)
    if (
      request.intentKind === "email.reply" ||
      request.intentKind === "email.forward"
    )
      return sendReplyOrForward(options, request)
    const ids = await requestedIds(request)
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
      case "email.archive":
      case "email.trash": {
        const priorLabels = await labelsBefore(options, request.connector, ids)
        await write()
        return { upstreamRef: null, result: { priorLabels } }
      }
      case "email.untrash": {
        const body: unknown = JSON.parse(request.body)
        if (!isRecord(body) || !Array.isArray(body["restores"]))
          throw new Error("invalid Gmail untrash request")
        for (const entry of body["restores"]) {
          if (
            !isRecord(entry) ||
            typeof entry["messageId"] !== "string" ||
            !Array.isArray(entry["labels"]) ||
            !entry["labels"].every((label) => typeof label === "string")
          )
            throw new Error("invalid Gmail untrash request")
          const labels = entry["labels"]
          const wasTrashed = labels.includes("TRASH")
          await call(options, request.url, request.connector, {
            method: "POST",
            body: JSON.stringify({
              ids: [entry["messageId"]],
              addLabelIds: labels,
              ...(wasTrashed ? {} : { removeLabelIds: ["TRASH"] }),
            }),
          })
        }
        return { upstreamRef: null, result: {} }
      }
      default:
        await write()
        return { upstreamRef: null, result: {} }
    }
  }
}
