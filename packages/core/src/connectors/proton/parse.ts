import PostalMime from "postal-mime"
import type { Address } from "postal-mime"
import { htmlToText } from "./html-text"

// Raw bytes from the gate are untrusted mail. postal-mime does the MIME work (multipart, transfer
// encodings, charsets, headers); this file only shapes its result for the index.

export type Mailbox = { name?: string; address: string }

export type ParsedAttachment = {
  filename: string
  mime: string
  content: Uint8Array
}

export type ParsedMessage = {
  messageId?: string
  inReplyTo?: string
  references: string[]
  subject: string
  date?: string
  from: Mailbox[]
  to: Mailbox[]
  cc: Mailbox[]
  /** The text part when there is one, otherwise the HTML part reduced to text. */
  text: string
  attachments: ParsedAttachment[]
}

function mailboxes(addresses: Address[] | Address | undefined): Mailbox[] {
  const list = addresses === undefined ? [] : [addresses].flat()
  return list.flatMap((a) =>
    a.group !== undefined
      ? mailboxes(a.group)
      : [{ ...(a.name === "" ? {} : { name: a.name }), address: a.address }]
  )
}

function bytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : new Uint8Array(content)
}

export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  const email = await PostalMime.parse(raw)
  const text =
    email.text ?? (email.html === undefined ? "" : htmlToText(email.html))
  return {
    ...(email.messageId === undefined ? {} : { messageId: email.messageId }),
    ...(email.inReplyTo === undefined ? {} : { inReplyTo: email.inReplyTo }),
    references: (email.references ?? "").split(/\s+/).filter((r) => r !== ""),
    subject: email.subject ?? "",
    ...(email.date === undefined ? {} : { date: email.date }),
    from: mailboxes(email.from),
    to: mailboxes(email.to),
    cc: mailboxes(email.cc),
    text: text.trim(),
    attachments: email.attachments.map((a, index) => ({
      filename: a.filename ?? `attachment-${index + 1}`,
      mime: a.mimeType,
      content: bytes(a.content),
    })),
  }
}

const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/csv",
  "message/rfc822",
])

export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || TEXT_TYPES.has(mime)
}

/** The attachment's text, or null for a type that is not text. Never executes or renders anything. */
export function attachmentText(attachment: ParsedAttachment): string | null {
  if (!isTextMime(attachment.mime)) return null
  const text = new TextDecoder("utf-8").decode(attachment.content)
  return attachment.mime === "text/html" ? htmlToText(text) : text
}
