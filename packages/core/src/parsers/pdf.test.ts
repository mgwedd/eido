import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  fakeEngine,
  readPgm,
  scanImage,
  scannedPdf,
  textPdf,
} from "./fixtures.test-support"
import { buildText } from "./offsets"
import { checkXref, parsePdf } from "./pdf"
import { DEFAULT_LIMITS, ParseFailed, resolveLimits } from "./types"

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-pdf-"))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ocr = (binary: string | null) => ({
  binary,
  workDir: dir,
  deadline: Date.now() + 10_000,
  maxOutputBytes: 1024 * 1024,
})

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ParseFailed) return error.reason
    throw error
  }
  throw new Error("expected a failure")
}

const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes)
const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))

describe("checkXref", () => {
  const good = textPdf([["a"]])

  it("accepts a file whose startxref points at its xref table", () => {
    expect(() => checkXref(good)).not.toThrow()
  })

  it.each([
    ["truncated", good.subarray(0, good.length - 20)],
    [
      "pointing past the end",
      bytes(latin1(good).replace(/startxref\n\d+/, "startxref\n999999")),
    ],
    [
      "pointing into the header",
      bytes(latin1(good).replace(/startxref\n\d+/, "startxref\n2")),
    ],
    ["empty", new Uint8Array()],
  ])("rejects a file %s", (_, input) => {
    expect(() => checkXref(input)).toThrow(ParseFailed)
  })
})

describe("parsePdf", () => {
  it("reads each page's lines with the page number", async () => {
    const { sections, pages } = await parsePdf(
      textPdf([["Lorem", "ipsum"], ["dolor"]]),
      DEFAULT_LIMITS,
      ocr(null)
    )
    expect(pages).toBe(2)
    expect(sections).toEqual([
      { page: 1, lines: ["Lorem", "ipsum"] },
      { page: 2, lines: ["dolor"] },
    ])
  })

  it("is oversize past the page limit", async () => {
    const limits = resolveLimits({ pdfPages: 1 })
    expect(
      await failure(parsePdf(textPdf([["a"], ["b"]]), limits, ocr(null)))
    ).toBe("oversize")
  })

  it("is malformed when the body is damaged behind a valid xref", async () => {
    const text = latin1(textPdf([["Lorem"]]))
    // Same length, so the xref offsets still line up, but the page points at no object.
    const broken = bytes(text.replace("/Kids [4 0 R]", "/Kids [9 0 R]"))
    expect(broken).not.toEqual(bytes(text))
    expect(await failure(parsePdf(broken, DEFAULT_LIMITS, ocr(null)))).toBe(
      "malformed"
    )
  })

  it("is malformed for bytes that are not a PDF at all", async () => {
    const fake = bytes("%PDF-1.4\ngarbage\nxref\nstartxref\n9\n%%EOF\n")
    expect(await failure(parsePdf(fake, DEFAULT_LIMITS, ocr(null)))).toBe(
      "malformed"
    )
  })

  it("sends a page with no text layer to OCR", async () => {
    const engine = fakeEngine(dir, "scan.sh", "printf 'Lorem ipsum\\n\\n'")
    const { sections } = await parsePdf(
      scannedPdf(readPgm(scanImage())),
      DEFAULT_LIMITS,
      ocr(engine)
    )
    expect(sections).toEqual([{ page: 1, lines: ["Lorem ipsum"] }])
  })

  it("is ocr_unavailable for a scanned page with no engine", async () => {
    expect(
      await failure(
        parsePdf(scannedPdf(readPgm(scanImage())), DEFAULT_LIMITS, ocr(null))
      )
    ).toBe("ocr_unavailable")
  })

  it("is oversize when more pages need OCR than the limit", async () => {
    const engine = fakeEngine(dir, "scan2.sh", "printf 'x'")
    const limits = resolveLimits({ ocrPages: 1 })
    expect(
      await failure(
        parsePdf(scannedPdf(readPgm(scanImage()), 2), limits, ocr(engine))
      )
    ).toBe("oversize")
    const { sections } = await parsePdf(
      scannedPdf(readPgm(scanImage()), 2),
      DEFAULT_LIMITS,
      ocr(engine)
    )
    expect(sections.map((s) => s.page)).toEqual([1, 2])
    expect(buildText(sections).text).toBe("x\nx")
  })
})
