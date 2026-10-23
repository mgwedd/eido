import { readFileSync } from "node:fs"
import { readJob, writeResult } from "./child-io"
import { parseMail } from "./mime"
import { ocrFile } from "./ocr"
import { buildText } from "./offsets"
import type { Section } from "./offsets"
import { parsePdf } from "./pdf"
import { formatOf, mismatch, normalizeMime } from "./sniff"
import { LIMIT_NAMES, ParseFailed, resolveLimits } from "./types"
import type { ParseLimits, ParseResult } from "./types"

// The parse child's entry point. It runs in its own short-lived process (sandbox.ts) with an
// empty environment, the no-network preload and a heap cap, parses one stored original, writes
// the result and exits. It calls nothing: no gate, no model, no network.

export type WorkerPayload = {
  blobPath: string
  sha256: string
  mime: string
  limits: ParseLimits
  ocrBinary: string | null
}

/** Checks the payload the parent wrote; throws on anything else. */
export function parsePayload(value: unknown): WorkerPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    !("blobPath" in value && "sha256" in value && "mime" in value) ||
    !("limits" in value && "ocrBinary" in value) ||
    typeof value.blobPath !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof value.mime !== "string" ||
    !(value.ocrBinary === null || typeof value.ocrBinary === "string") ||
    typeof value.limits !== "object" ||
    value.limits === null
  ) {
    throw new Error("not a parse payload")
  }
  const given = value.limits
  const limits: Partial<ParseLimits> = {}
  for (const name of LIMIT_NAMES) {
    const limit: unknown = Reflect.get(given, name)
    if (typeof limit !== "number") throw new Error(`no ${name} limit`)
    limits[name] = limit
  }
  return {
    blobPath: value.blobPath,
    sha256: value.sha256,
    mime: value.mime,
    limits: resolveLimits(limits),
    ocrBinary: value.ocrBinary,
  }
}

async function sections(
  raw: Uint8Array,
  payload: WorkerPayload,
  workDir: string,
  deadline: number
): Promise<{ sections: Section[]; pages: number | null }> {
  const { limits } = payload
  const format = formatOf(payload.mime)
  if (format === null) {
    throw new ParseFailed(
      "unsupported",
      `${normalizeMime(payload.mime)} is not parsed`
    )
  }
  const wrong = mismatch(payload.mime, raw)
  if (wrong !== null) throw new ParseFailed("unsupported", wrong)
  const ocr = {
    binary: payload.ocrBinary,
    workDir,
    deadline,
    maxOutputBytes: limits.outputChars * 4,
  }
  switch (format) {
    case "mime":
    case "mbox":
      return { sections: await parseMail(raw, format, limits), pages: null }
    case "pdf":
      return parsePdf(raw, limits, ocr)
    case "image": {
      const pages = await ocrFile(payload.blobPath, ocr)
      if (pages.length > limits.ocrPages) {
        throw new ParseFailed(
          "oversize",
          `${String(pages.length)} image pages, more than ${String(limits.ocrPages)}`
        )
      }
      return {
        sections: pages.map((text, index) => ({
          page: index + 1,
          lines: text === "" ? [] : text.split("\n"),
        })),
        pages: pages.length,
      }
    }
  }
}

/** Parses one stored original. Never throws: every failure is a result. */
export async function runParse(
  payload: WorkerPayload,
  workDir: string
): Promise<ParseResult> {
  const { sha256, limits } = payload
  const deadline = Date.now() + limits.timeoutMs
  try {
    const raw = new Uint8Array(readFileSync(payload.blobPath))
    const parsed = await sections(raw, payload, workDir, deadline)
    const { text, offsets } = buildText(parsed.sections)
    if (text.length > limits.outputChars) {
      throw new ParseFailed(
        "oversize",
        `${String(text.length)} characters of text, more than ${String(limits.outputChars)}`
      )
    }
    return {
      ok: true,
      sha256,
      trust: "untrusted",
      text,
      offsets,
      pages: parsed.pages,
    }
  } catch (error) {
    if (error instanceof ParseFailed) {
      return { ok: false, sha256, reason: error.reason, detail: error.message }
    }
    const name = error instanceof Error ? error.name : "unknown"
    return {
      ok: false,
      sha256,
      reason: "crashed",
      detail: `the parser failed (${name})`,
    }
  }
}

if (import.meta.main) {
  const job = readJob()
  writeResult(job, await runParse(parsePayload(job.payload), job.workDir))
}
