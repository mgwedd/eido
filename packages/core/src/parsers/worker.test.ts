import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readJob, writeResult } from "./child-io"
import {
  fakeEngine,
  message,
  scanImage,
  textPdf,
} from "./fixtures.test-support"
import { storeOriginal } from "./store"
import { DEFAULT_LIMITS, resolveLimits } from "./types"
import type { ParseLimits } from "./types"
import { parsePayload, runParse } from "./worker"
import type { WorkerPayload } from "./worker"

// The child's logic, run in-process so it is covered; parse-document.test.ts runs it in a child.

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-worker-"))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function payload(
  bytes: Uint8Array,
  mime: string,
  extra: Partial<WorkerPayload> = {}
): WorkerPayload {
  const { sha256, blobPath } = storeOriginal(dir, bytes)
  return {
    blobPath,
    sha256,
    mime,
    limits: { ...DEFAULT_LIMITS },
    ocrBinary: null,
    ...extra,
  }
}

describe("parsePayload", () => {
  const good = {
    blobPath: "/b",
    sha256: "s",
    mime: "application/pdf",
    limits: DEFAULT_LIMITS,
    ocrBinary: null,
  }

  it("accepts a payload the parent wrote", () => {
    expect(parsePayload(JSON.parse(JSON.stringify(good)))).toEqual(good)
    expect(
      parsePayload({ ...good, ocrBinary: "/usr/bin/tesseract" }).ocrBinary
    ).toBe("/usr/bin/tesseract")
  })

  it.each([
    ["null", null],
    ["a string", "payload"],
    ["no mime", { ...good, mime: undefined }],
    ["a numeric path", { ...good, blobPath: 1 }],
    ["a numeric hash", { ...good, sha256: 1 }],
    ["a numeric engine", { ...good, ocrBinary: 1 }],
    ["no limits", { ...good, limits: null }],
    [
      "a string limit",
      { ...good, limits: { ...DEFAULT_LIMITS, heapMiB: "512" } },
    ],
    [
      "a missing limit",
      { ...good, limits: { ...DEFAULT_LIMITS, mimeDepth: undefined } },
    ],
  ])("refuses %s", (_, value) => {
    expect(() => parsePayload(value)).toThrow()
  })

  it("refuses a limit that is not a positive integer", () => {
    expect(() =>
      parsePayload({ ...good, limits: { ...DEFAULT_LIMITS, timeoutMs: -1 } })
    ).toThrow(RangeError)
  })
})

describe("runParse", () => {
  it("parses a PDF into text and offsets", async () => {
    const p = payload(textPdf([["Lorem"], ["ipsum"]]), "application/pdf")
    expect(await runParse(p, dir)).toEqual({
      ok: true,
      sha256: p.sha256,
      trust: "untrusted",
      text: "Lorem\nipsum",
      offsets: [
        { offset: 0, page: 1, line: 1 },
        { offset: 6, page: 2, line: 1 },
      ],
      pages: 2,
    })
  })

  it("parses a message with null pages", async () => {
    const result = await runParse(
      payload(message({ body: "Lorem body" }), "message/rfc822; charset=x"),
      dir
    )
    expect(result.ok && result.pages).toBeNull()
    expect(result.ok && result.text).toContain("\nLorem body")
  })

  it.each([
    ["an unparsed type", "text/csv", "text/csv is not parsed"],
    [
      "a mismatched type",
      "image/png",
      "declared image/png but the bytes are application/pdf",
    ],
  ])("is unsupported for %s", async (_, mime, detail) => {
    const p = payload(textPdf([["x"]]), mime)
    expect(await runParse(p, dir)).toEqual({
      ok: false,
      sha256: p.sha256,
      reason: "unsupported",
      detail,
    })
  })

  it("is oversize when the text passes the output limit", async () => {
    const limits: ParseLimits = resolveLimits({ outputChars: 3 })
    const result = await runParse(
      payload(textPdf([["Lorem"]]), "application/pdf", { limits }),
      dir
    )
    expect(result).toMatchObject({
      ok: false,
      reason: "oversize",
      detail: "5 characters of text, more than 3",
    })
  })

  it("reads an image with the OCR engine, one page per form feed", async () => {
    const engine = fakeEngine(
      dir,
      "two.sh",
      "printf 'Lorem\\nipsum\\fdolor\\f'"
    )
    const result = await runParse(
      payload(scanImage(), "image/x-portable-graymap", { ocrBinary: engine }),
      dir
    )
    if (!result.ok) throw new Error(result.detail)
    expect(result.text).toBe("Lorem\nipsum\ndolor")
    expect(result.pages).toBe(2)
    expect(result.offsets).toEqual([
      { offset: 0, page: 1, line: 1 },
      { offset: 6, page: 1, line: 2 },
      { offset: 12, page: 2, line: 1 },
    ])
  })

  it("keeps a blank image page as a page with no lines", async () => {
    const engine = fakeEngine(dir, "blank.sh", "printf '\\f'")
    const result = await runParse(
      payload(scanImage(), "image/x-portable-graymap", { ocrBinary: engine }),
      dir
    )
    expect(result).toMatchObject({ ok: true, text: "", offsets: [], pages: 1 })
  })

  it("is oversize when an image has more pages than the OCR limit", async () => {
    const engine = fakeEngine(dir, "many.sh", "printf 'a\\fb\\fc'")
    const limits = resolveLimits({ ocrPages: 2 })
    const result = await runParse(
      payload(scanImage(), "image/x-portable-graymap", {
        ocrBinary: engine,
        limits,
      }),
      dir
    )
    expect(result).toMatchObject({
      ok: false,
      reason: "oversize",
      detail: "3 image pages, more than 2",
    })
  })

  it("is ocr_unavailable for an image with no engine", async () => {
    const result = await runParse(
      payload(scanImage(), "image/x-portable-graymap"),
      dir
    )
    expect(result).toMatchObject({ ok: false, reason: "ocr_unavailable" })
  })

  it("reports an unexpected error as crashed instead of throwing", async () => {
    const p = {
      ...payload(textPdf([["x"]]), "application/pdf"),
      blobPath: join(dir, "gone"),
    }
    expect(await runParse(p, dir)).toEqual({
      ok: false,
      sha256: p.sha256,
      reason: "crashed",
      detail: "the parser failed (Error)",
    })
  })
})

describe("child-io", () => {
  it("reads the job named by the first argument and writes the result once", () => {
    const jobPath = join(dir, "job.json")
    const resultPath = join(dir, "result.json")
    writeFileSync(
      jobPath,
      JSON.stringify({ resultPath, workDir: dir, payload: { a: 1 } })
    )
    const job = readJob(["node", "worker.ts", jobPath])
    expect(job).toEqual({ resultPath, workDir: dir, payload: { a: 1 } })
    writeResult(job, { ok: true })
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({ ok: true })
    expect(() => writeResult(job, { ok: false })).toThrow(/EEXIST/)
  })

  it("leaves the payload undefined when the job has none", () => {
    const jobPath = join(dir, "bare.json")
    writeFileSync(jobPath, JSON.stringify({ resultPath: "/r", workDir: "/w" }))
    expect(readJob(["node", "x", jobPath]).payload).toBeUndefined()
  })

  it("refuses a missing argument or a file that is not a job", () => {
    expect(() => readJob(["node", "x"])).toThrow(
      "the parse child needs a job file"
    )
    const jobPath = join(dir, "bad.json")
    writeFileSync(jobPath, JSON.stringify({ resultPath: 1, workDir: "/w" }))
    expect(() => readJob(["node", "x", jobPath])).toThrow(
      "the job file is not a parse job"
    )
    writeFileSync(jobPath, "null")
    expect(() => readJob(["node", "x", jobPath])).toThrow(
      "the job file is not a parse job"
    )
  })
})
