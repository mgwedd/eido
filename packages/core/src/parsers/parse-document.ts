import { createHash } from "node:crypto"
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createLimiter } from "./limiter"
import { runInChild } from "./sandbox"
import {
  createPrivateWorkDirectory,
  preparePrivateScratchRoot,
} from "./private-scratch"
import { blobPath, isSha256, storeOriginal } from "./store"
import { FAILURE_REASONS, resolveLimits } from "./types"
import type { OffsetEntry, ParseLimits, ParseResult } from "./types"
import type { WorkerPayload } from "./worker"

// The parent side: what sync jobs and the extraction pipeline call. Each parse runs in its own
// child (worker.ts through sandbox.ts); a bad file becomes `{ ok: false, reason }`, the stored
// original is kept, and the caller's process carries on.

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "worker.ts")

/**
 * What the parser needs of the broker's client (`BrokerClient` in broker-client.ts, which imports
 * this module for `readParseResult`, so the type is named here by shape).
 */
export type ParserBroker = {
  parseBytes: (
    bytes: Uint8Array,
    mime: string,
    limits?: Partial<ParseLimits>
  ) => Promise<ParseResult>
}

export type ParserConfig = {
  /** The data plane's data dir: originals live under `blobs/`, parse work dirs under `parse-tmp/`. */
  dataDir: string
  /** The OCR engine (Tesseract's command line) by absolute path; without one, OCR is `ocr_unavailable`. */
  ocrBinary?: string
  /** Parses running at once; the rest queue. Default 2. */
  maxConcurrent?: number
  /** Overrides of the default limits for every parse. */
  limits?: Partial<ParseLimits>
  /**
   * The parser broker (#817), set under the plane split. Every parse then goes to it and none runs
   * in a child of this process, so `ocrBinary` is the broker's own setting and no scratch dir is
   * made here. A broker that fails is a `crashed` result: there is no local fallback, because a
   * child here would give the parser this process's network reach back.
   */
  broker?: ParserBroker
}

export type Parser = {
  parseDocument: (
    input: { blobSha256: string; mime: string },
    limits?: Partial<ParseLimits>
  ) => Promise<ParseResult>
  storeOriginal: (bytes: Uint8Array) => { sha256: string; blobPath: string }
  /**
   * Parses bytes that are not kept: they go to a private scratch file for the child and are
   * removed afterwards. For local files, whose originals the data dir must not copy.
   */
  parseBytes: (
    bytes: Uint8Array,
    mime: string,
    limits?: Partial<ParseLimits>
  ) => Promise<ParseResult>
}

const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0

function offsetEntry(value: unknown): OffsetEntry | null {
  if (typeof value !== "object" || value === null) return null
  if (!("offset" in value && "line" in value)) return null
  const { offset, line } = value
  if (!isCount(offset) || !isCount(line)) return null
  const entry: OffsetEntry = { offset, line }
  for (const key of ["messageId", "part"] as const) {
    const field: unknown = Reflect.get(value, key)
    if (field === undefined) continue
    if (typeof field !== "string") return null
    entry[key] = field
  }
  const page: unknown = Reflect.get(value, "page")
  if (page !== undefined) {
    if (!isCount(page)) return null
    entry.page = page
  }
  return entry
}

/**
 * Checks what the child wrote. The child handles hostile bytes, so its answer is not trusted
 * either: anything off-shape, or for another hash, is a crash.
 */
export function readParseResult(
  value: unknown,
  sha256: string,
  limits: ParseLimits
): ParseResult {
  const crashed: ParseResult = {
    ok: false,
    sha256,
    reason: "crashed",
    detail: "the parser returned a malformed result",
  }
  if (typeof value !== "object" || value === null) return crashed
  if (!("ok" in value && "sha256" in value) || value.sha256 !== sha256) {
    return crashed
  }
  if (value.ok === false) {
    if (!("reason" in value && "detail" in value)) return crashed
    const reason = FAILURE_REASONS.find((r) => r === value.reason)
    if (reason === undefined || typeof value.detail !== "string") return crashed
    return { ok: false, sha256, reason, detail: value.detail }
  }
  if (value.ok !== true) return crashed
  if (!("text" in value && "offsets" in value && "pages" in value)) {
    return crashed
  }
  const { text, offsets, pages } = value
  if (typeof text !== "string" || text.length > limits.outputChars) {
    return crashed
  }
  if (!(pages === null || isCount(pages)) || !Array.isArray(offsets)) {
    return crashed
  }
  const table: OffsetEntry[] = []
  for (const raw of offsets) {
    const entry = offsetEntry(raw)
    const previous = table.at(-1)
    if (entry === null || entry.offset > text.length) return crashed
    if (previous !== undefined && entry.offset < previous.offset) return crashed
    table.push(entry)
  }
  return { ok: true, sha256, trust: "untrusted", text, offsets: table, pages }
}

export function createParser(config: ParserConfig): Parser {
  const base = resolveLimits(config.limits)
  const limit = createLimiter(config.maxConcurrent ?? 2)
  const tmpRoot = join(config.dataDir, "parse-tmp")
  const { broker } = config
  if (broker === undefined) preparePrivateScratchRoot(tmpRoot)

  async function parse(
    input: { blobSha256: string; mime: string },
    limits: ParseLimits
  ): Promise<ParseResult> {
    const sha256 = input.blobSha256
    if (!isSha256(sha256)) {
      return {
        ok: false,
        sha256,
        reason: "malformed",
        detail: "not a SHA-256 hex digest",
      }
    }
    const path = blobPath(config.dataDir, sha256)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return {
        ok: false,
        sha256,
        reason: "malformed",
        detail: "no stored original has this hash",
      }
    }
    // Decided from the file's size alone: an oversize original is never read.
    if (size > limits.inputBytes) {
      return {
        ok: false,
        sha256,
        reason: "oversize",
        detail: `${String(size)} bytes, more than ${String(limits.inputBytes)}`,
      }
    }
    if (broker !== undefined) {
      return sendToBroker(broker, path, sha256, input.mime, limits)
    }
    return runWorker(path, sha256, input.mime, limits)
  }

  /** Reads the stored original and has the broker parse it; the broker hashes what it receives. */
  async function sendToBroker(
    client: ParserBroker,
    path: string,
    sha256: string,
    mime: string,
    limits: ParseLimits
  ): Promise<ParseResult> {
    const result = await limit(() =>
      client.parseBytes(readFileSync(path), mime, limits)
    )
    // The blob is named by its hash; bytes that hash to something else are not that original.
    if (result.sha256 !== sha256) {
      return {
        ok: false,
        sha256,
        reason: "malformed",
        detail: "the stored original does not match its hash",
      }
    }
    return result
  }

  async function runWorker(
    path: string,
    sha256: string,
    mime: string,
    limits: ParseLimits
  ): Promise<ParseResult> {
    const payload: WorkerPayload = {
      blobPath: path,
      sha256,
      mime,
      limits,
      ocrBinary: config.ocrBinary ?? null,
    }
    const outcome = await limit(() =>
      runInChild({
        entry: WORKER,
        payload,
        tmpRoot,
        limits: {
          timeoutMs: limits.timeoutMs,
          heapMiB: limits.heapMiB,
          // The text JSON-escaped (up to 6 bytes a character) plus an offset entry per line.
          resultBytes: limits.outputChars * 16 + 1024 * 1024,
        },
      })
    )
    if (!outcome.ok)
      return {
        ok: false,
        sha256,
        reason: outcome.reason,
        detail: outcome.detail,
      }
    return readParseResult(outcome.value, sha256, limits)
  }

  return {
    parseDocument: async (input, overrides = {}) => {
      // Bad limits are the caller's bug and throw; nothing about the file does.
      const limits = resolveLimits(overrides, base)
      try {
        return await parse(input, limits)
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown"
        return {
          ok: false,
          sha256: input.blobSha256,
          reason: "crashed",
          detail: `the parse could not run (${name})`,
        }
      }
    },
    parseBytes: async (bytes, mime, overrides = {}) => {
      const limits = resolveLimits(overrides, base)
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      if (bytes.byteLength > limits.inputBytes) {
        return {
          ok: false,
          sha256,
          reason: "oversize",
          detail: `${String(bytes.byteLength)} bytes, more than ${String(limits.inputBytes)}`,
        }
      }
      // The broker's client answers `crashed` itself; it does not throw.
      if (broker !== undefined) {
        return await limit(() => broker.parseBytes(bytes, mime, limits))
      }
      let workDir: string | undefined
      try {
        workDir = createPrivateWorkDirectory(tmpRoot)
        const path = join(workDir, "original")
        writeFileSync(path, bytes, { flag: "wx", mode: 0o600 })
        return await runWorker(path, sha256, mime, limits)
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown"
        return {
          ok: false,
          sha256,
          reason: "crashed",
          detail: `the parse could not run (${name})`,
        }
      } finally {
        if (workDir !== undefined)
          rmSync(workDir, { recursive: true, force: true })
      }
    },
    storeOriginal: (bytes) => storeOriginal(config.dataDir, bytes),
  }
}
