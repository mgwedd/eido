import { execFile } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { ParseFailed } from "./types"

// OCR runs the configured engine binary (Tesseract's command line: `<binary> <image> stdout`).
// It gets an empty environment and the image path; no network is involved. With no binary
// configured, or one that cannot be started, the parse is `ocr_unavailable`: never empty text
// reported as success.

export type OcrConfig = {
  /** The OCR engine's absolute path, or null when none is configured. */
  binary: string | null
  /** Where the image files the engine reads are written; removed by the parent after the parse. */
  workDir: string
  /** Epoch ms after which the engine is killed. */
  deadline: number
  maxOutputBytes: number
}

const UNAVAILABLE = new Set(["ENOENT", "EACCES", "ENOTDIR", "EPERM"])

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined
  }
  return String(error.code)
}

/** The text of every page the engine reads in `imagePath`, one string per page. */
export function ocrFile(
  imagePath: string,
  config: OcrConfig
): Promise<string[]> {
  const { binary } = config
  if (binary === null) {
    return Promise.reject(
      new ParseFailed("ocr_unavailable", "no OCR engine is configured")
    )
  }
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [imagePath, "stdout"],
      {
        env: { OMP_THREAD_LIMIT: "1" },
        timeout: Math.max(1, config.deadline - Date.now()),
        killSignal: "SIGKILL",
        maxBuffer: config.maxOutputBytes,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error === null) {
          const pages = stdout.split("\f").map((page) => page.trimEnd())
          if (pages.length > 1 && pages.at(-1) === "") pages.pop()
          resolve(pages)
          return
        }
        const code = errorCode(error)
        if (code !== undefined && UNAVAILABLE.has(code)) {
          reject(
            new ParseFailed(
              "ocr_unavailable",
              `the OCR engine could not be started (${code})`
            )
          )
        } else if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          // Checked before `killed`: Node kills an engine that overflows the buffer too.
          reject(new ParseFailed("oversize", "the OCR output is too large"))
        } else if (error.killed) {
          reject(new ParseFailed("timeout", "the OCR engine ran out of time"))
        } else {
          const status = error.signal ?? code ?? "unknown"
          reject(
            new ParseFailed(
              "malformed",
              `the OCR engine could not read the image (exit ${status})`
            )
          )
        }
      }
    )
  })
}

/** A decoded PDF image as pdf.js returns it: kind 1 is 1-bit grey, 2 is RGB, 3 is RGBA. */
export type RawImage = {
  width: number
  height: number
  kind: number
  data: Uint8Array | Uint8ClampedArray
}

/** The image as an 8-bit binary PGM (P5), which the engine reads without any codec. */
export function toPgm(image: RawImage): Uint8Array {
  const { width, height, kind, data } = image
  const grey = new Uint8Array(width * height)
  const rowBytes = Math.ceil(width / 8)
  // Short (truncated) pixel data reads as black rather than out of range.
  const at = (index: number): number => data[index] ?? 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      if (kind === 1) {
        const byte = at(y * rowBytes + (x >> 3))
        grey[i] = (byte >> (7 - (x & 7))) & 1 ? 255 : 0
      } else {
        const stride = kind === 3 ? 4 : 3
        grey[i] = Math.round(
          0.299 * at(i * stride) +
            0.587 * at(i * stride + 1) +
            0.114 * at(i * stride + 2)
        )
      }
    }
  }
  const header = new TextEncoder().encode(
    `P5\n${String(width)} ${String(height)}\n255\n`
  )
  const out = new Uint8Array(header.length + grey.length)
  out.set(header)
  out.set(grey, header.length)
  return out
}

let counter = 0

/** Writes `image` to the work dir and reads it with the engine. */
export async function ocrImage(
  image: RawImage,
  config: OcrConfig
): Promise<string[]> {
  if (config.binary === null) {
    throw new ParseFailed("ocr_unavailable", "no OCR engine is configured")
  }
  counter += 1
  const path = join(config.workDir, `page-${String(counter)}.pgm`)
  writeFileSync(path, toPgm(image), { flag: "wx", mode: 0o600 })
  return ocrFile(path, config)
}
