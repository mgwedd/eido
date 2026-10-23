import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Synthetic inputs, built in the test: tiny PDFs, hand-written MIME and one committed image of
// rendered placeholder text (fixtures/parsers/scan-lorem.pgm). No real documents or names.

const encoder = new TextEncoder()

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A PDF from objects 1..n (object 1 is the catalog), with a correct xref table. */
function assemble(objects: Array<string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode("%PDF-1.4\n")]
  let length = parts[0]?.length ?? 0
  const offsets: number[] = []
  const push = (part: Uint8Array) => {
    parts.push(part)
    length += part.length
  }
  objects.forEach((object, index) => {
    offsets.push(length)
    push(encoder.encode(`${String(index + 1)} 0 obj\n`))
    push(typeof object === "string" ? encoder.encode(object) : object)
    push(encoder.encode("\nendobj\n"))
  })
  const xref = length
  const size = objects.length + 1
  push(
    encoder.encode(
      `xref\n0 ${String(size)}\n0000000000 65535 f \n` +
        offsets
          .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
          .join("") +
        `trailer\n<< /Size ${String(size)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`
    )
  )
  return concat(parts)
}

function stream(dict: string, body: Uint8Array): Uint8Array {
  return concat([
    encoder.encode(`<< ${dict} /Length ${String(body.length)} >>\nstream\n`),
    body,
    encoder.encode("\nendstream"),
  ])
}

/** A text PDF: one array of lines per page, in Helvetica. */
export function textPdf(pages: string[][]): Uint8Array {
  // 1 catalog, 2 pages, 3 font, then a page and its content stream per page.
  const kids = pages.map((_, i) => `${String(4 + i * 2)} 0 R`).join(" ")
  const objects: Array<string | Uint8Array> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  pages.forEach((lines, i) => {
    const content = lines
      .map(
        (line, n) =>
          `BT /F1 12 Tf 72 ${String(720 - n * 16)} Td (${line}) Tj ET`
      )
      .join("\n")
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${String(5 + i * 2)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      stream("", encoder.encode(content))
    )
  })
  return assemble(objects)
}

export type Pgm = { width: number; height: number; pixels: Uint8Array }

export function readPgm(bytes: Uint8Array): Pgm {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64))
  const match = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(head)
  if (match === null) throw new Error("not an 8-bit binary PGM")
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    pixels: bytes.subarray(match[0].length),
  }
}

/** A scanned PDF: `pages` pages that are each only a greyscale image, with no text layer. */
export function scannedPdf(image: Pgm, pages = 1): Uint8Array {
  const { width, height } = image
  const draw = `q ${String(width)} 0 0 ${String(height)} 0 0 cm /Im1 Do Q`
  // 1 catalog, 2 pages, 3 the image, then a page and its content stream per page.
  const kids = Array.from(
    { length: pages },
    (_, i) => `${String(4 + i * 2)} 0 R`
  ).join(" ")
  const objects: Array<string | Uint8Array> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${String(pages)} >>`,
    stream(
      `/Type /XObject /Subtype /Image /Width ${String(width)} /Height ${String(height)} /ColorSpace /DeviceGray /BitsPerComponent 8`,
      image.pixels
    ),
  ]
  for (let i = 0; i < pages; i += 1) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(width)} ${String(height)}] /Contents ${String(5 + i * 2)} 0 R /Resources << /XObject << /Im1 3 0 R >> >> >>`,
      stream("", encoder.encode(draw))
    )
  }
  return assemble(objects)
}

/** An executable stand-in for the OCR engine: a shell script that runs `body`. */
export function fakeEngine(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return path
}

const REPO = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".."
)

/** An image of the words "Lorem ipsum dolor" rendered in Helvetica (synthetic; see fixtures/parsers/README.md). */
export function scanImage(): Uint8Array {
  return new Uint8Array(
    readFileSync(join(REPO, "fixtures", "parsers", "scan-lorem.pgm"))
  )
}

/** A hand-written RFC 5322 message. */
export function message(options: {
  id?: string
  subject?: string
  headers?: string[]
  body: string
  type?: string
}): Uint8Array {
  const lines = [
    "From: Lorem Sender <sender@example.invalid>",
    "To: owner@example.invalid",
    `Subject: ${options.subject ?? "Lorem ipsum"}`,
    "Date: Mon, 5 Oct 2026 09:00:00 +0000",
    ...(options.id === undefined ? [] : [`Message-ID: <${options.id}>`]),
    "MIME-Version: 1.0",
    `Content-Type: ${options.type ?? "text/plain; charset=utf-8"}`,
    ...(options.headers ?? []),
    "",
    options.body,
  ]
  return encoder.encode(lines.join("\r\n"))
}

/** A message whose multipart parts nest `depth` levels below the top. */
export function nestedMessage(depth: number): Uint8Array {
  let body = "Content-Type: text/plain\r\n\r\nLorem ipsum"
  for (let level = depth; level >= 1; level -= 1) {
    body =
      `Content-Type: multipart/mixed; boundary="b${String(level)}"\r\n\r\n` +
      `--b${String(level)}\r\n${body}\r\n--b${String(level)}--`
  }
  const [head = "", ...rest] = body.split("\r\n\r\n")
  return message({
    type: head.replace(/^Content-Type: /, ""),
    body: rest.join("\r\n\r\n"),
  })
}

/** A multipart message with `count` small text attachments. */
export function attachmentsMessage(count: number): Uint8Array {
  const parts = Array.from(
    { length: count },
    (_, i) =>
      `--att\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="note-${String(i + 1)}.txt"\r\n\r\nLorem ${String(i + 1)}`
  )
  return message({
    type: 'multipart/mixed; boundary="att"',
    body: [
      "--att\r\nContent-Type: text/plain\r\n\r\nLorem ipsum body",
      ...parts,
      "--att--",
    ].join("\r\n"),
  })
}

/** The OCR engine on PATH, or null when this machine has none. */
export function findTesseract(): string | null {
  try {
    const found = execFileSync("/bin/sh", ["-c", "command -v tesseract"], {
      encoding: "utf8",
    }).trim()
    return found === "" ? null : found
  } catch {
    return null
  }
}
