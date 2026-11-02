import type { Parser } from "../../parsers/index"
import type { OffsetEntry } from "../../parsers/index"
import { stripInvisible } from "./html-text"
import type { ParsedAttachment } from "./parse"

/**
 * The text of a PDF attachment, read by the sandboxed parser (#43) from a stored copy of its bytes.
 * Null when the parse fails or passes a limit: the attachment is then indexed with no text and
 * the caller carries on.
 */
export async function pdfAttachmentText(
  parser: Parser,
  attachment: ParsedAttachment
): Promise<{ text: string; pages: { page: number; text: string }[] } | null> {
  const { sha256 } = parser.storeOriginal(attachment.content)
  const result = await parser.parseDocument({
    blobSha256: sha256,
    mime: attachment.mime,
  })
  if (!result.ok || result.pages === null) return null
  const text = stripInvisible(result.text)
  const offsets = result.offsets
  const pages: { page: number; text: string }[] = []
  for (let page = 1; page <= result.pages; page += 1) {
    const entries = offsets.filter((entry) => entry.page === page)
    pages.push({
      page,
      text: pageText(result.text, offsets, entries),
    })
  }
  return {
    text,
    pages: pages.map((page) => ({ ...page, text: stripInvisible(page.text) })),
  }
}

function pageText(
  text: string,
  offsets: readonly OffsetEntry[],
  entries: readonly OffsetEntry[]
): string {
  const first = entries[0]
  const last = entries.at(-1)
  if (first === undefined || last === undefined) return ""
  const next = offsets[offsets.indexOf(last) + 1]
  const end = next === undefined ? text.length : next.offset - 1
  return text.slice(first.offset, end)
}
