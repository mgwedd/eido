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
 * Parsed text as the model reads it: normalized (see `normalizeMaterial`) one line at a time, the
 * offset table rebuilt for the new lengths. Quotes are verified, and spans point, into this text,
 * so what the owner is shown is exactly what the model read.
 */
export type NormalizedText = {
  text: string
  offsets: OffsetTable
  runs: Run[]
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
  let length = 0
  starts.forEach((start, i) => {
    // The first run is whatever precedes the first entry; it is empty for a table built by
    // `buildText`. Each entry's run ends where the next one starts.
    const end = starts[i + 1] ?? text.length
    const material = toMaterial(text.slice(start, end), { source: "document" })
    const piece = materialText(material)
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
  return { text: pieces.join(""), offsets: table, runs }
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
