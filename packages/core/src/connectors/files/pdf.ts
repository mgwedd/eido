import type { Parser } from "../../parsers/index"
import { FileError } from "./path"

/**
 * Text-layer extraction only, in the sandboxed parse child (the bytes are hostile and a PDF
 * library bug must not reach the data-plane process). Scans needing OCR produce a typed failure.
 */
export async function pdfText(
  parser: Pick<Parser, "parseBytes">,
  bytes: Uint8Array
): Promise<string> {
  const result = await parser.parseBytes(bytes, "application/pdf")
  if (!result.ok) throw new FileError("invalid_pdf")
  return result.text
}
