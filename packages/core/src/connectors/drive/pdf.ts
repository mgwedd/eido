import { parsePdf } from "../../parsers/pdf"
import { DEFAULT_LIMITS } from "../../parsers/types"
import { DriveError } from "./errors"

/** Text-layer extraction only. Scans needing OCR produce a typed failure. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    if (bytes.byteLength > DEFAULT_LIMITS.inputBytes)
      throw new DriveError("invalid_pdf")
    const result = await parsePdf(bytes, DEFAULT_LIMITS, {
      binary: null,
      workDir: "",
      deadline: Date.now() + DEFAULT_LIMITS.timeoutMs,
      maxOutputBytes: DEFAULT_LIMITS.outputChars,
    })
    return result.sections.flatMap((section) => section.lines).join("\n")
  } catch {
    throw new DriveError("invalid_pdf")
  }
}
