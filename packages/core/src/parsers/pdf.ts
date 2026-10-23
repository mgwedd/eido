import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs"
import { ocrImage } from "./ocr"
import type { OcrConfig, RawImage } from "./ocr"
import type { Section } from "./offsets"
import { ParseFailed } from "./types"
import type { ParseLimits } from "./types"

// PDF text through pdf.js (Mozilla's parser, pure JavaScript), with XFA, font loading, fetching
// and rendering off: only the text layer and raw image pixels are read. A page with no
// text layer is a scan and goes to OCR.

/**
 * Throws `malformed` unless the file ends with `startxref <n> %%EOF` and offset n holds a
 * cross-reference table or stream. pdf.js would otherwise rebuild a broken table by scanning,
 * which turns a truncated or tampered file into a partial success.
 */
export function checkXref(raw: Uint8Array): void {
  const latin1 = new TextDecoder("latin1")
  const tail = latin1.decode(raw.subarray(Math.max(0, raw.length - 1024)))
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)
  const offset = Number(match?.[1] ?? NaN)
  const target = Number.isSafeInteger(offset)
    ? latin1.decode(raw.subarray(offset, offset + 32))
    : ""
  if (!/^\s*(?:xref\b|\d+\s+\d+\s+obj\b)/.test(target)) {
    throw new ParseFailed(
      "malformed",
      "the PDF has no valid cross-reference table (truncated or damaged)"
    )
  }
}

function isRawImage(value: unknown): value is RawImage {
  if (typeof value !== "object" || value === null) return false
  if (!("width" in value && "height" in value && "kind" in value)) return false
  if (!("data" in value)) return false
  return (
    Number.isInteger(value.width) &&
    Number.isInteger(value.height) &&
    [1, 2, 3].includes(Number(value.kind)) &&
    (value.data instanceof Uint8Array ||
      value.data instanceof Uint8ClampedArray)
  )
}

function pageObject(page: PDFPageProxy, name: string): Promise<unknown> {
  const store = name.startsWith("g_") ? page.commonObjs : page.objs
  return new Promise((resolve) => {
    store.get(name, resolve)
  })
}

/** The decoded images a page paints, in drawing order. */
async function pageImages(page: PDFPageProxy): Promise<RawImage[]> {
  const ops = await page.getOperatorList()
  const images: RawImage[] = []
  for (const [index, fn] of ops.fnArray.entries()) {
    const args: unknown = ops.argsArray[index]
    const arg: unknown = Array.isArray(args) ? args[0] : undefined
    let image: unknown = null
    if (fn === OPS.paintImageXObject && typeof arg === "string") {
      image = await pageObject(page, arg)
    } else if (fn === OPS.paintInlineImageXObject) {
      image = arg
    }
    if (isRawImage(image)) images.push(image)
  }
  return images
}

async function textLines(page: PDFPageProxy): Promise<string[]> {
  const content = await page.getTextContent()
  const lines = [""]
  for (const item of content.items) {
    if (!("str" in item)) continue
    lines[lines.length - 1] += item.str
    if (item.hasEOL) lines.push("")
  }
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop()
  return lines
}

async function open(
  raw: Uint8Array
): Promise<{ doc: PDFDocumentProxy; close: () => Promise<void> }> {
  const task = getDocument({
    // pdf.js takes ownership of the buffer it is given.
    data: raw.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: true,
    verbosity: 0,
  })
  try {
    return { doc: await task.promise, close: () => task.destroy() }
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    throw name === "PasswordException"
      ? new ParseFailed("unsupported", "the PDF is encrypted")
      : new ParseFailed("malformed", `the PDF could not be read (${name})`)
  }
}

export async function parsePdf(
  raw: Uint8Array,
  limits: ParseLimits,
  ocr: OcrConfig
): Promise<{ sections: Section[]; pages: number }> {
  checkXref(raw)
  const { doc, close } = await open(raw)
  try {
    if (doc.numPages > limits.pdfPages) {
      throw new ParseFailed(
        "oversize",
        `${String(doc.numPages)} pages, more than ${String(limits.pdfPages)}`
      )
    }
    const sections: Section[] = []
    let scanned = 0
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number)
      let lines = await textLines(page)
      if (lines.length === 0) {
        const images = await pageImages(page)
        if (images.length > 0) scanned += 1
        if (scanned > limits.ocrPages) {
          throw new ParseFailed(
            "oversize",
            `more than ${String(limits.ocrPages)} pages need OCR`
          )
        }
        const read: string[] = []
        for (const image of images) read.push(...(await ocrImage(image, ocr)))
        lines = read.join("\n").split("\n")
        while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop()
      }
      sections.push({ page: number, lines })
    }
    return { sections, pages: doc.numPages }
  } catch (error) {
    if (error instanceof ParseFailed) throw error
    const name = error instanceof Error ? error.name : ""
    throw new ParseFailed("malformed", `a PDF page could not be read (${name})`)
  } finally {
    await close()
  }
}
