import { stripInvisible } from "../connectors/mail/html-text"
import { parseMessage } from "../connectors/mail/parse"
import type { Mailbox, ParsedMessage } from "../connectors/mail/parse"
import { splitLines } from "./offsets"
import type { Section } from "./offsets"
import { ParseFailed } from "./types"
import type { ParseLimits } from "./types"

// RFC 5322 messages, alone or as an mbox. The MIME work and the HTML-to-text conversion are the
// mail connectors' own (connectors/mail): postal-mime decodes, and htmlToText drops scripts,
// styles, images and hidden text without fetching anything. This file checks structure and
// limits first, and lays each message out as offset-table sections.

const HEADER_FIELD = /^[\x21-\x39\x3b-\x7e]+:/
const CONTINUATION = /^[ \t]/

/** Throws `malformed` unless `raw` opens with a well-formed RFC 5322 header block. */
export function checkHeaders(raw: Uint8Array): void {
  const head = new TextDecoder("latin1").decode(raw.subarray(0, 256 * 1024))
  const end = head.search(/\r?\n\r?\n/)
  const block = end === -1 ? head : head.slice(0, end)
  const lines = splitLines(block)
  if (!HEADER_FIELD.test(lines[0] ?? "")) {
    throw new ParseFailed("malformed", "the message has no header fields")
  }
  const bad = lines.findIndex(
    (line) =>
      line.includes("\0") ||
      !(HEADER_FIELD.test(line) || CONTINUATION.test(line))
  )
  if (bad !== -1) {
    throw new ParseFailed(
      "malformed",
      `header line ${String(bad + 1)} is not a header field`
    )
  }
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ")
  const type = /^content-type:\s*multipart\/[^\r\n]*/im.exec(unfolded)
  if (type !== null && !/boundary\s*=/i.test(type[0])) {
    throw new ParseFailed("malformed", "a multipart message has no boundary")
  }
}

/** Splits an mbox at its "From " separator lines; each message is returned without its separator. */
export function splitMbox(raw: Uint8Array): Uint8Array[] {
  const text = new TextDecoder("latin1").decode(raw)
  if (!text.startsWith("From ")) {
    throw new ParseFailed("malformed", 'an mbox must start with a "From " line')
  }
  // latin1 maps each byte to one character, so string indexes are byte offsets.
  const separators = [...text.matchAll(/(?:^|\n)From [^\n]*(?:\n|$)/g)]
  return separators.map((m, index) => {
    // The next separator, with the newline before it, is not part of this message.
    const end = separators[index + 1]?.index ?? raw.length
    return raw.subarray(m.index + m[0].length, end)
  })
}

function mailboxList(list: Mailbox[]): string {
  return list
    .map((m) => (m.name === undefined ? m.address : `${m.name} <${m.address}>`))
    .join(", ")
}

/** Untrusted names and values on one line: no line breaks, no invisible characters. */
function oneLine(value: string): string {
  return stripInvisible(value).replace(/[\r\n]+/g, " ")
}

function sections(message: ParsedMessage): Section[] {
  const id =
    message.messageId === undefined ? {} : { messageId: message.messageId }
  const header = [
    `Subject: ${oneLine(message.subject)}`,
    ...(
      [
        ["From", message.from],
        ["To", message.to],
        ["Cc", message.cc],
      ] as const
    ).flatMap(([name, list]) =>
      list.length === 0 ? [] : [`${name}: ${oneLine(mailboxList(list))}`]
    ),
    ...(message.date === undefined ? [] : [`Date: ${oneLine(message.date)}`]),
  ]
  const attachments = message.attachments.map(
    (a) =>
      `Attachment: ${oneLine(a.filename)} (${oneLine(a.mime)}, ${String(a.content.length)} bytes)`
  )
  return [
    { ...id, part: "header", lines: [...header, ""] },
    { ...id, part: "body", lines: splitLines(message.text) },
    ...(attachments.length === 0
      ? []
      : [{ ...id, part: "attachments", lines: ["", ...attachments] }]),
  ]
}

async function parseOne(
  raw: Uint8Array,
  limits: ParseLimits
): Promise<Section[]> {
  checkHeaders(raw)
  let message: ParsedMessage
  try {
    message = await parseMessage(raw, {
      maxNestingDepth: limits.mimeDepth,
      // Bounds the work before the attachment count is known: every attachment is a part, and so
      // is each multipart container on the way down.
      maxPartCount: 2 * limits.mimeAttachments + limits.mimeDepth + 2,
      maxRfc822NestingDepth: 0,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ParseFailed(
      /^Maximum /.test(detail) ? "oversize" : "malformed",
      detail
    )
  }
  if (message.attachments.length > limits.mimeAttachments) {
    throw new ParseFailed(
      "oversize",
      `${String(message.attachments.length)} attachments, more than ${String(limits.mimeAttachments)}`
    )
  }
  return sections(message)
}

/** The sections of one message, or of every message in an mbox, separated by a blank line. */
export async function parseMail(
  raw: Uint8Array,
  format: "mime" | "mbox",
  limits: ParseLimits
): Promise<Section[]> {
  const messages = format === "mbox" ? splitMbox(raw) : [raw]
  const all: Section[] = []
  for (const message of messages) {
    const parsed = await parseOne(message, limits)
    const last = all.at(-1)
    if (last !== undefined) last.lines.push("")
    all.push(...parsed)
  }
  return all
}
