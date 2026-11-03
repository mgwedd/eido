import {
  INJECTION_REASONS,
  fence,
  materialText,
  toMaterial,
} from "../inference/index"
import type { InjectionReason } from "../inference/index"
import type { OffsetTable } from "../parsers/types"
import type { Passage } from "./types"

/** One run of the normalized text, from one offset entry to the next, with what it hid. */
type Run = { start: number; end: number; reasons: readonly InjectionReason[] }

/**
 * Parsed text as the model reads it: normalized (see `normalizeMaterial`) one line at a time, with
 * offsets rebuilt for the normalized lengths. Quotes are matched against this normalized text;
 * stored SourceSpan ranges map back to the original parsed text for source highlighting.
 */
export type NormalizedText = {
  text: string
  offsets: OffsetTable
  originalOffsets: OffsetTable
  runs: Run[]
  /** Normalized UTF-16 code units mapped to their original parsed text ranges. */
  sourceStarts: number[]
  sourceEnds: number[]
}

/** Maps a non-empty normalized UTF-16 span to the original parsed text range. */
export function originalRangeForNormalized(
  doc: NormalizedText,
  start: number,
  end: number
): { start: number; end: number } {
  const originalStart = doc.sourceStarts[start]
  const originalEnd = doc.sourceEnds[end - 1]
  if (
    originalStart === undefined ||
    originalEnd === undefined ||
    end <= start
  ) {
    throw new RangeError("normalized span is outside the text")
  }
  return { start: originalStart, end: originalEnd }
}

/** Normalizes run by run, so line numbers, pages and message ids stay as the parser set them. */
export function normalizeParsed(parsed: {
  text: string
  offsets: OffsetTable
}): NormalizedText {
  const { text, offsets } = parsed
  const starts = [0, ...offsets.map((entry) => entry.offset)]
  const pieces: string[] = []
  const runs: Run[] = []
  const table: OffsetTable = []
  const sourceStarts: number[] = []
  const sourceEnds: number[] = []
  let length = 0
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  starts.forEach((start, i) => {
    // The first run is whatever precedes the first entry; it is empty for a table built by
    // `buildText`. Each entry's run ends where the next one starts.
    const end = starts[i + 1] ?? text.length
    const material = toMaterial(text.slice(start, end), { source: "document" })
    const piece = materialText(material)
    // Normalize grapheme by grapheme so combining sequences stay together, while mapping each
    // output code unit to the original UTF-16 range that produced it.
    let localOffset = 0
    const sourceMapStart = sourceStarts.length
    for (const segment of segmenter.segment(text.slice(start, end))) {
      const rawStart = start + localOffset
      const rawEnd = rawStart + segment.segment.length
      const normalizedSegment = materialText(
        toMaterial(segment.segment, { source: "document" })
      )
      for (let i = 0; i < normalizedSegment.length; i += 1) {
        sourceStarts.push(rawStart)
        sourceEnds.push(rawEnd)
      }
      localOffset += segment.segment.length
    }
    if (sourceStarts.length - sourceMapStart !== piece.length) {
      throw new RangeError(
        "normalization span map does not match normalized text"
      )
    }
    const entry = offsets[i - 1]
    if (entry !== undefined) table.push({ ...entry, offset: length })
    runs.push({
      start: length,
      end: length + piece.length,
      reasons: fence(material).reasons,
    })
    pieces.push(piece)
    length += piece.length
  })
  return {
    text: pieces.join(""),
    offsets: table,
    originalOffsets: offsets,
    runs,
    sourceStarts,
    sourceEnds,
  }
}

/**
 * The reasons for one passage: those found in its runs while normalizing (hidden characters,
 * defused tags), and those only visible across lines (boundary confusion).
 */
export function passageReasons(
  doc: NormalizedText,
  passage: Passage
): InjectionReason[] {
  const found = new Set<InjectionReason>(
    fence(toMaterial(passage.text, { source: "document" })).reasons
  )
  for (const run of doc.runs) {
    if (run.start < passage.end && run.end > passage.start) {
      for (const reason of run.reasons) found.add(reason)
    }
  }
  return INJECTION_REASONS.filter((reason) => found.has(reason))
}
