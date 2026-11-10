import type { Parser } from "../../parsers/index"
import { parsePdf } from "../../parsers/pdf"
import { DEFAULT_LIMITS } from "../../parsers/types"
import { FileError } from "./path"

/**
 * Text-layer extraction only. With a parser, the bytes go to the sandboxed parse child (they are
 * hostile and a PDF library bug must not reach the data-plane process). Without one (Windows,
 * where the parser's private scratch is unsupported) they are parsed in this process, bounded by
 * the default limits. Scans needing OCR produce a typed failure.
 */
export async function pdfText(
  parser: Pick<Parser, "parseBytes"> | undefined,
  bytes: Uint8Array
): Promise<string> {
  if (parser !== undefined) {
    const result = await parser.parseBytes(bytes, "application/pdf")
    if (!result.ok) throw new FileError("invalid_pdf")
    return result.text
  }
  try {
    if (bytes.byteLength > DEFAULT_LIMITS.inputBytes)
      throw new FileError("invalid_pdf")
    const result = await parsePdf(Uint8Array.from(bytes), DEFAULT_LIMITS, {
      binary: null,
      workDir: "",
      deadline: Date.now() + DEFAULT_LIMITS.timeoutMs,
      maxOutputBytes: DEFAULT_LIMITS.outputChars,
    })
    return result.sections.flatMap((section) => section.lines).join("\n")
  } catch {
    throw new FileError("invalid_pdf")
  }
}
