import { randomUUID } from "node:crypto"

// Just enough RFC 5322 / MIME for mail the connector reads and writes: header decoding,
// text bodies, attachments, and an outgoing message builder.

export type Address = { name?: string; address: string }

export type Attachment = {
  /** Position among the message's attachments, in document order. */
  index: number
  filename: string
  mime: string
  data: Buffer
}

export type ParsedMessage = {
  messageId?: string
  inReplyTo?: string
  references: string[]
  subject: string
  /** ISO 8601, from the Date header. */
  date?: string
  from: Address[]
  to: Address[]
  cc: Address[]
  text: string
  attachments: Attachment[]
}

type Headers = Map<string, string>

function splitMessage(raw: Buffer): { head: string; body: Buffer } {
  const text = raw.toString("latin1")
  const crlf = text.indexOf("\r\n\r\n")
  const lf = text.indexOf("\n\n")
  const useCrlf = crlf >= 0 && (lf < 0 || crlf <= lf)
  const at = useCrlf ? crlf : lf
  if (at < 0) return { head: text, body: Buffer.alloc(0) }
  return { head: text.slice(0, at), body: raw.subarray(at + (useCrlf ? 4 : 2)) }
}

function parseHeaders(head: string): Headers {
  const headers: Headers = new Map()
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ")
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim())
  }
  return headers
}

function decodeBytes(data: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(data)
  } catch {
    return new TextDecoder("utf-8").decode(data)
  }
}

function qpBytes(input: string, header: boolean): Buffer {
  const text = (header ? input.replace(/_/g, " ") : input).replace(
    /=\r?\n/g,
    ""
  )
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const hex = text.slice(i + 1, i + 3)
    if (text.charAt(i) === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16))
      i += 2
    } else out.push(text.charCodeAt(i) & 0xff)
  }
  return Buffer.from(out)
}

/** RFC 2047 encoded words in a header value. */
export function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (_all, charset: string, enc: string, data: string) =>
        decodeBytes(
          enc.toLowerCase() === "b"
            ? Buffer.from(data, "base64")
            : qpBytes(data, true),
          charset
        )
    )
}

function parseAddresses(value: string | undefined): Address[] {
  if (value === undefined) return []
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let current = ""
  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    if (!quoted && ch === "<") depth++
    if (!quoted && ch === ">") depth--
    if (!quoted && depth === 0 && ch === ",") {
      parts.push(current)
      current = ""
    } else current += ch
  }
  parts.push(current)
  const out: Address[] = []
  for (const part of parts) {
    const angle = angleSpan(part)
    const address = (angle?.inner ?? part).trim()
    if (!address.includes("@")) continue
    const name = decodeWords(
      removeFirstBrackets(part)
        .replace(/^\s*"|"\s*$/g, "")
        .trim()
    )
    out.push({ ...(angle !== null && name !== "" ? { name } : {}), address })
  }
  return out
}

function params(value: string): { type: string; params: Map<string, string> } {
  const [type = "", ...rest] = value.split(";")
  const map = new Map<string, string>()
  for (const item of rest) {
    const eq = item.indexOf("=")
    if (eq < 0) continue
    map.set(
      item.slice(0, eq).trim().toLowerCase(),
      item
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "")
    )
  }
  return { type: type.trim().toLowerCase(), params: map }
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? "7bit").toLowerCase()
  if (enc === "base64")
    return Buffer.from(body.toString("latin1").replace(/\s+/g, ""), "base64")
  if (enc === "quoted-printable") return qpBytes(body.toString("latin1"), false)
  return body
}

/**
 * The first `<...>` span with a non-empty inside, found by index scanning (linear time, no regex
 * backtracking on adversarial input). `inner` is the text between the brackets.
 */
export function angleSpan(
  value: string
): { inner: string; start: number; end: number } | null {
  let start = value.indexOf("<")
  while (start >= 0) {
    const end = value.indexOf(">", start + 1)
    if (end < 0) return null
    if (end > start + 1)
      return { inner: value.slice(start + 1, end), start, end: end + 1 }
    start = value.indexOf("<", end)
  }
  return null
}

function removeFirstBrackets(value: string): string {
  const start = value.indexOf("<")
  const end = start < 0 ? -1 : value.indexOf(">", start)
  return end < 0 ? value : value.slice(0, start) + value.slice(end + 1)
}

const BLOCK_ENDS = new Set(["p", "div", "br"])

/**
 * HTML to plain text with a single linear scan. Every `<...>` span is dropped (script and style
 * with their content), and any `<` or `>` left over is removed too, so nested or overlapping
 * input such as `<scr<script>ipt>` cannot leave markup behind. Entities are decoded after
 * stripping, and `&amp;` last, so decoded text is never reinterpreted.
 */
function stripHtml(html: string): string {
  let out = ""
  let i = 0
  while (i < html.length) {
    const open = html.indexOf("<", i)
    if (open < 0) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, open)
    const close = html.indexOf(">", open + 1)
    if (close < 0) break
    const tag = html.slice(open + 1, close)
    const name = /^\/?([a-zA-Z0-9]+)/.exec(tag.slice(0, 20))?.[1]?.toLowerCase()
    i = close + 1
    if (name === undefined) continue
    if ((name === "script" || name === "style") && !tag.startsWith("/")) {
      const end = html.toLowerCase().indexOf(`</${name}`, i)
      if (end < 0) break
      const endClose = html.indexOf(">", end)
      i = endClose < 0 ? html.length : endClose + 1
    } else if (BLOCK_ENDS.has(name) && (name === "br" || tag.startsWith("/"))) {
      out += "\n"
    }
  }
  return out
    .replace(/[<>]/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

type Walk = { text: string[]; html: string[]; attachments: Attachment[] }

function walk(head: string, body: Buffer, out: Walk): void {
  const headers = parseHeaders(head)
  const ct = params(headers.get("content-type") ?? "text/plain")
  const boundary = ct.params.get("boundary")
  if (ct.type.startsWith("multipart/") && boundary !== undefined) {
    const raw = body.toString("latin1")
    const marker = `--${boundary}`
    const sections = raw.split(marker).slice(1)
    for (const section of sections) {
      if (section.startsWith("--")) break
      const trimmed = section.replace(/^\r?\n/, "")
      const part = splitMessage(Buffer.from(trimmed, "latin1"))
      walk(part.head, part.body, out)
    }
    return
  }
  const data = decodeBody(body, headers.get("content-transfer-encoding"))
  const disposition = params(headers.get("content-disposition") ?? "")
  const filename = decodeWords(
    disposition.params.get("filename") ?? ct.params.get("name") ?? ""
  )
  const isAttachment =
    disposition.type === "attachment" ||
    filename !== "" ||
    !(ct.type === "text/plain" || ct.type === "text/html")
  if (isAttachment) {
    out.attachments.push({
      index: out.attachments.length,
      filename:
        filename === "" ? `part-${out.attachments.length + 1}` : filename,
      mime: ct.type,
      data,
    })
    return
  }
  const decoded = decodeBytes(data, ct.params.get("charset"))
  ;(ct.type === "text/html" ? out.html : out.text).push(decoded)
}

export function parseMessage(raw: Buffer): ParsedMessage {
  const { head, body } = splitMessage(raw)
  const headers = parseHeaders(head)
  const out: Walk = { text: [], html: [], attachments: [] }
  walk(head, body, out)
  const id = (value: string | undefined): string | undefined => {
    const m = /<[^<>\s]+>/.exec(value ?? "")
    return m?.[0]
  }
  const date = headers.get("date")
  const parsedDate = date === undefined ? NaN : Date.parse(date)
  const messageId = id(headers.get("message-id"))
  const inReplyTo = id(headers.get("in-reply-to"))
  return {
    ...(messageId === undefined ? {} : { messageId }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    references: [
      ...(headers.get("references") ?? "").matchAll(/<[^<>\s]+>/g),
    ].map((m) => m[0]),
    subject: decodeWords(headers.get("subject") ?? ""),
    ...(Number.isNaN(parsedDate)
      ? {}
      : { date: new Date(parsedDate).toISOString() }),
    from: parseAddresses(headers.get("from")),
    to: parseAddresses(headers.get("to")),
    cc: parseAddresses(headers.get("cc")),
    text:
      out.text.length > 0
        ? out.text.join("\n").trim()
        : stripHtml(out.html.join("\n")),
    attachments: out.attachments,
  }
}

/** Attachment content as text, for text-like types only. Others have no text to give. */
export function attachmentText(attachment: Attachment): string | null {
  const textual =
    attachment.mime.startsWith("text/") ||
    attachment.mime === "application/json" ||
    attachment.mime.endsWith("+xml") ||
    attachment.mime === "application/xml"
  if (!textual) return null
  const text = decodeBytes(attachment.data, undefined)
  return attachment.mime === "text/html" ? stripHtml(text) : text
}

export type OutgoingMessage = {
  from: string
  to: readonly string[]
  cc?: readonly string[]
  /** Not written to any header. */
  bcc?: readonly string[]
  subject: string
  text: string
  inReplyTo?: string
  references?: readonly string[]
  /** An iCalendar body sent as a text/calendar alternative (used by calendar invitations, #21). */
  calendar?: { method: "REQUEST" | "CANCEL" | "REPLY"; ics: string }
  messageId?: string
  date?: Date
}

const CRLF = "\r\n"
const asciiSafe = (value: string): string => {
  if (/[\r\n]/.test(value))
    throw new RangeError("header value has a line break")
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
}
const b64 = (text: string): string =>
  (
    Buffer.from(text, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join(CRLF)

/** An RFC 5322 message with CRLF line endings, ready for SMTP DATA or IMAP APPEND. */
export function buildMessage(message: OutgoingMessage): {
  raw: string
  messageId: string
} {
  const domain = message.from.split("@")[1] ?? "example.invalid"
  const messageId = message.messageId ?? `<${randomUUID()}@${domain}>`
  const lines = [
    `From: ${asciiSafe(message.from)}`,
    `To: ${message.to.map(asciiSafe).join(", ")}`,
    ...(message.cc?.length
      ? [`Cc: ${message.cc.map(asciiSafe).join(", ")}`]
      : []),
    `Subject: ${asciiSafe(message.subject)}`,
    `Date: ${(message.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(message.inReplyTo
      ? [`In-Reply-To: ${asciiSafe(message.inReplyTo)}`]
      : []),
    ...(message.references?.length
      ? [`References: ${message.references.map(asciiSafe).join(" ")}`]
      : []),
    "MIME-Version: 1.0",
  ]
  const textPart = [
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(message.text),
  ]
  if (message.calendar === undefined) {
    return { raw: [...lines, ...textPart, ""].join(CRLF), messageId }
  }
  const boundary = `eido-${randomUUID()}`
  const body = [
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    `Content-Type: text/calendar; charset="utf-8"; method=${message.calendar.method}`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(message.calendar.ics),
    `--${boundary}--`,
    "",
  ]
  return {
    raw: [
      ...lines,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      ...body,
    ].join(CRLF),
    messageId,
  }
}
