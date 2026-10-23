import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"
import type { OffsetTable } from "../parsers/types"
import type { Passage } from "./types"

// Obligation-phrase prefilter: only passages around an obligation phrase reach the model, so a
// small model reads a few windows instead of the whole document.

export const DEFAULT_PHRASES: readonly string[] = [
  "renew",
  "terminate",
  "due by",
  "past due",
  "notice",
]
export const DEFAULT_WINDOW_CHARS = 1500
export const DEFAULT_MAX_PASSAGES = 12

export type PrefilterOptions = {
  /** Matched case-insensitively at word starts; whitespace inside a phrase matches any run of it. */
  phrases?: readonly string[]
  /** Longest passage, in UTF-16 code units. Default 1,500. */
  windowChars?: number
  /** Most passages sent to the model. Default 12. */
  maxPassages?: number
  /** Tokens the chosen passages may take together, overhead included. Default: no limit. */
  tokenBudget?: number
  /** Tokens each passage costs on top of its own text (system prompt, wrapper, reply). Default 0. */
  overheadTokens?: number
  charsPerToken?: number
}

export type PrefilterResult = {
  /** The passages to read, in document order. */
  passages: Passage[]
  /** Every merged window the phrases produced, chosen or not. */
  total: number
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** One regex for every phrase, anchored at a word start (no letter, digit or `_` before it). */
export function phraseRegExp(phrases: readonly string[]): RegExp | null {
  const alternatives = phrases.map((phrase) => {
    const words = phrase.trim().split(/\s+/)
    if (words[0] === "") throw new RangeError("a prefilter phrase is empty")
    return words.map(escapeRegExp).join("\\s+")
  })
  if (alternatives.length === 0) return null
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})`, "giu")
}

/**
 * Paragraphs of `text`, in order, as `[start, end)`. A paragraph ends at a blank line or where
 * the offset table changes message or message part, so a window never spans two sources.
 */
export function paragraphs(
  text: string,
  offsets: OffsetTable
): Array<[number, number]> {
  const breaks: Array<[number, number]> = []
  for (const match of text.matchAll(/\n(?:[ \t\r]*\n)+/g)) {
    breaks.push([match.index, match.index + match[0].length])
  }
  for (let i = 1; i < offsets.length; i += 1) {
    // i - 1 and i are in range: the loop runs from 1 to offsets.length - 1.
    const previous = offsets[i - 1]!
    const entry = offsets[i]!
    if (
      entry.offset > 0 &&
      (entry.messageId !== previous.messageId || entry.part !== previous.part)
    ) {
      breaks.push([entry.offset - 1, entry.offset])
    }
  }
  breaks.sort((a, b) => a[0] - b[0])
  const result: Array<[number, number]> = []
  let start = 0
  for (const [end, next] of breaks) {
    if (next <= start) continue // inside a break already taken
    if (end > start) result.push([start, end])
    start = next
  }
  if (start < text.length) result.push([start, text.length])
  return result
}

/** The window for a hit: its paragraph, or `cap` characters of it centred on the hit. */
function windowFor(
  hit: number,
  hitLength: number,
  paragraph: [number, number],
  cap: number
): [number, number] {
  const [ps, pe] = paragraph
  if (pe - ps <= cap) return [ps, pe]
  let start = Math.max(ps, hit - Math.floor(Math.max(0, cap - hitLength) / 2))
  const end = Math.min(pe, start + cap)
  start = Math.max(ps, end - cap)
  return [start, end]
}

/** Overlapping windows merge while the union fits `cap`; otherwise the later one starts where the earlier ends. */
function mergeWindows(
  windows: Array<[number, number]>,
  cap: number
): Array<[number, number]> {
  const merged: Array<[number, number]> = []
  for (const [start, end] of windows) {
    const last = merged.at(-1)
    if (last === undefined || start >= last[1]) {
      merged.push([start, end])
    } else if (end - last[0] <= cap) {
      last[1] = Math.max(last[1], end)
    } else {
      // The union is over the cap, so end > last[0] + cap >= last[1]: the remainder is non-empty.
      merged.push([last[1], end])
    }
  }
  return merged
}

/** `k` indices out of `n`, spread evenly by position: the middle of each of `k` equal slices. */
export function evenlySpaced(n: number, k: number): number[] {
  return Array.from({ length: k }, (_, i) => Math.floor(((i + 0.5) * n) / k))
}

/**
 * Passages around obligation phrases. Each hit becomes its enclosing paragraph (capped at
 * `windowChars`), overlapping windows are merged, and when there are more than `maxPassages` or
 * they do not fit `tokenBudget`, the passages read are spread evenly across the document rather
 * than taken from its start. No hits gives no passages.
 */
export function selectCandidatePassages(
  text: string,
  offsets: OffsetTable,
  opts: PrefilterOptions = {}
): PrefilterResult {
  const cap = positiveInteger(
    "windowChars",
    opts.windowChars ?? DEFAULT_WINDOW_CHARS
  )
  const maxPassages = positiveInteger(
    "maxPassages",
    opts.maxPassages ?? DEFAULT_MAX_PASSAGES
  )
  const budget = opts.tokenBudget ?? Number.POSITIVE_INFINITY
  const overhead = opts.overheadTokens ?? 0
  const charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const regex = phraseRegExp(opts.phrases ?? DEFAULT_PHRASES)
  if (regex === null) return { passages: [], total: 0 }

  const paras = paragraphs(text, offsets)
  const windows: Array<[number, number]> = []
  let p = 0
  for (const match of text.matchAll(regex)) {
    // A hit is never inside a break (breaks are whitespace), so some paragraph holds it.
    while (paras[p]![1] <= match.index) p += 1
    windows.push(windowFor(match.index, match[0].length, paras[p]!, cap))
  }
  const all = mergeWindows(windows, cap).map(
    ([start, end]): Passage => ({ start, end, text: text.slice(start, end) })
  )

  const cost = (passages: Passage[]): number =>
    passages.reduce(
      (sum, passage) => sum + estimateTokens(passage.text, charsPerToken) + overhead,
      0
    )
  for (let k = Math.min(all.length, maxPassages); k > 0; k -= 1) {
    // evenlySpaced returns indices below all.length, since (i + 0.5) * n / k < n for i < k.
    const chosen = evenlySpaced(all.length, k).map((i) => all[i]!)
    if (cost(chosen) <= budget) return { passages: chosen, total: all.length }
  }
  return { passages: [], total: all.length }
}
