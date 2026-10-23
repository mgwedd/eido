// Types shared by the parent (parse-document.ts) and the parse child (worker.ts).

/** One entry at the start of every line of `text`, sorted by offset. */
export type OffsetEntry = {
  offset: number
  messageId?: string
  part?: string
  page?: number
  /** Counts from 1 within the page, or within the message part. */
  line: number
}

export type OffsetTable = OffsetEntry[]

export const FAILURE_REASONS = [
  "timeout",
  "memory",
  "oversize",
  "malformed",
  "unsupported",
  "ocr_unavailable",
  "crashed",
] as const

export type FailureReason = (typeof FAILURE_REASONS)[number]

export type ParseSuccess = {
  ok: true
  sha256: string
  /** Parsed text is always untrusted input: never instructions. */
  trust: "untrusted"
  /** Exactly the string quotes are checked against later; never normalized after the table is built. */
  text: string
  offsets: OffsetTable
  /** Pages for a PDF or an image, null for mail. */
  pages: number | null
}

export type ParseFailure = {
  ok: false
  sha256: string
  reason: FailureReason
  detail: string
}

export type ParseResult = ParseSuccess | ParseFailure

/** Per-parse resource limits. Every field is a positive integer. */
export type ParseLimits = {
  /** Wall-clock limit; the child is killed when it passes. */
  timeoutMs: number
  /** The child's V8 heap cap (`--max-old-space-size`). */
  heapMiB: number
  /** Largest stored original that is parsed at all. */
  inputBytes: number
  /** Largest parsed text, in UTF-16 code units. */
  outputChars: number
  pdfPages: number
  ocrPages: number
  /** Deepest MIME part nesting accepted. */
  mimeDepth: number
  /** Most attachments accepted in one message. */
  mimeAttachments: number
}

export const LIMIT_NAMES = [
  "timeoutMs",
  "heapMiB",
  "inputBytes",
  "outputChars",
  "pdfPages",
  "ocrPages",
  "mimeDepth",
  "mimeAttachments",
] as const satisfies ReadonlyArray<keyof ParseLimits>

export const DEFAULT_LIMITS: Readonly<ParseLimits> = {
  timeoutMs: 30_000,
  heapMiB: 512,
  inputBytes: 50 * 1024 * 1024,
  outputChars: 5 * 1024 * 1024,
  pdfPages: 500,
  ocrPages: 100,
  mimeDepth: 10,
  mimeAttachments: 50,
}

/** Merges `overrides` into the defaults; throws on a value that is not a positive integer. */
export function resolveLimits(
  overrides: Partial<ParseLimits> = {},
  base: Readonly<ParseLimits> = DEFAULT_LIMITS
): ParseLimits {
  const limits = { ...base, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`parse limit ${name} must be a positive integer`)
    }
  }
  return limits
}

/** Thrown inside a parser to end the parse with a failure reason. */
export class ParseFailed extends Error {
  readonly reason: FailureReason

  constructor(reason: FailureReason, detail: string) {
    super(detail)
    this.name = "ParseFailed"
    this.reason = reason
  }
}
