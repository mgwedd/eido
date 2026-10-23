import type { Parser } from "../../parsers/index"
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
): Promise<string | null> {
  const { sha256 } = parser.storeOriginal(attachment.content)
  const result = await parser.parseDocument({
    blobSha256: sha256,
    mime: attachment.mime,
  })
  return result.ok ? stripInvisible(result.text) : null
}
