import {
  DEFAULT_CHARS_PER_TOKEN,
  ESTIMATE_BOUNDARY,
  fence,
  normalizeMaterial,
  plainContent,
  toMaterial,
} from "../inference/index"
import type {
  FencedBlock,
  MaterialSource,
  PromptPart,
} from "../inference/index"
import { DigestBuildError } from "./types"
import type { DigestSubject } from "./types"

// Splits a source into sections that fit the section budget. Each message or page is one material
// block whose `ref` attribute the model cites back. Cuts fall on message or page boundaries; a
// reply stays with the message it answers when the pair fits. A message or page that alone
// exceeds the budget is split at paragraph boundaries (at code points only for a single paragraph
// that is itself too large), so every character reaches the model.

interface Segment {
  block: FencedBlock
  /** Code points of the block as the model reads it. */
  chars: number
}

export interface SectionPlan {
  /** The content of each model input: material blocks, then the task line. */
  sections: PromptPart[][]
  splitSegments: number
}

/** The last line of every section input, after the material. */
export const SECTION_TASK = "Summarize the material blocks above."

const SEPARATOR = "\n\n"

const codePoints = (text: string): number => [...text].length

const blockChars = (block: FencedBlock): number =>
  codePoints(plainContent([block], ESTIMATE_BOUNDARY))

const FRAME_CHARS = codePoints(`${SEPARATOR}${SECTION_TASK}`)

/** A section's content: its blocks, then the task line. */
function sectionContent(blocks: readonly FencedBlock[]): PromptPart[] {
  const parts: PromptPart[] = []
  for (const block of blocks) {
    if (parts.length > 0) parts.push(SEPARATOR)
    parts.push(block)
  }
  parts.push(`${SEPARATOR}${SECTION_TASK}`)
  return parts
}

// Reserves room for the longest part label so a split piece never overflows once labelled.
const WIDEST_PART = "99999 of 99999"

function splitBody(body: string, room: number): string[] {
  const pieces: string[] = []
  let current = ""
  const flush = (): void => {
    if (current !== "") pieces.push(current)
    current = ""
  }
  for (const paragraph of body.split(/\n{2,}/)) {
    const joined = current === "" ? paragraph : `${current}\n\n${paragraph}`
    if (codePoints(joined) <= room) {
      current = joined
      continue
    }
    flush()
    if (codePoints(paragraph) <= room) {
      current = paragraph
      continue
    }
    const chars = [...paragraph]
    for (let i = 0; i < chars.length; i += room) {
      pieces.push(chars.slice(i, i + room).join(""))
    }
  }
  flush()
  return pieces
}

function segmentsOf(
  source: MaterialSource,
  ref: string,
  raw: string,
  maxChars: number
): { segments: Segment[]; split: boolean } {
  const whole = fence(toMaterial(raw, { source, ref }))
  if (blockChars(whole) <= maxChars) {
    return {
      segments: [{ block: whole, chars: blockChars(whole) }],
      split: false,
    }
  }
  // Split the normalized text, so a piece never grows when it is normalized again.
  const body = normalizeMaterial(raw)
  const overhead = blockChars(
    fence(toMaterial("", { source, ref, part: WIDEST_PART }))
  )
  const room = maxChars - overhead
  if (room < 1) {
    throw new DigestBuildError(
      `section budget is too small for reference ${ref}`
    )
  }
  const pieces = splitBody(body, room)
  return {
    segments: pieces.map((piece, i) => {
      const block = fence(
        toMaterial(piece, {
          source,
          ref,
          part: `${String(i + 1)} of ${String(pieces.length)}`,
        })
      )
      return { block, chars: blockChars(block) }
    }),
    split: true,
  }
}

/** Units that stay together: a reply with the message it answers, a page alone. */
function unitsOf(
  subject: DigestSubject,
  maxChars: number
): { units: Segment[][]; splitSegments: number } {
  const units: Segment[][] = []
  let splitSegments = 0
  if (subject.kind === "document") {
    for (const { page, text } of subject.pages) {
      const { segments, split } = segmentsOf(
        "document",
        String(page),
        text,
        maxChars
      )
      units.push(segments)
      if (split) splitSegments += 1
    }
    return { units, splitSegments }
  }
  let lastId: string | undefined
  let lastUnitIsSingle = false
  for (const message of subject.messages) {
    const { segments, split } = segmentsOf(
      "mail",
      message.id,
      message.body,
      maxChars
    )
    if (split) splitSegments += 1
    const answersLast =
      message.inReplyTo !== undefined &&
      message.inReplyTo === lastId &&
      lastUnitIsSingle
    const last = units[units.length - 1]
    if (answersLast && last !== undefined) {
      last.push(...segments)
      lastUnitIsSingle = false
    } else {
      units.push(segments)
      lastUnitIsSingle = !split
    }
    lastId = message.id
  }
  return { units, splitSegments }
}

const SEPARATOR_CHARS = codePoints(SEPARATOR)

export function planSections(
  subject: DigestSubject,
  budget: number
): SectionPlan {
  // A section's blocks, with their separators, plus the task line fit the budget.
  const maxChars = budget * DEFAULT_CHARS_PER_TOKEN - FRAME_CHARS
  const { units, splitSegments } = unitsOf(subject, maxChars)
  const sections: PromptPart[][] = []
  let current: Segment[] = []
  let currentChars = 0

  const flush = (): void => {
    if (current.length > 0) {
      sections.push(sectionContent(current.map((s) => s.block)))
    }
    current = []
    currentChars = 0
  }
  const unitChars = (unit: readonly Segment[]): number =>
    unit.reduce((sum, s) => sum + s.chars, 0) +
    SEPARATOR_CHARS * (unit.length - 1)
  const add = (unit: Segment[]): void => {
    if (unit.length > 1 && unitChars(unit) > maxChars) {
      // The pair cannot share one section, so each message stands alone.
      for (const segment of unit) add([segment])
      return
    }
    const extra = unitChars(unit) + (current.length > 0 ? SEPARATOR_CHARS : 0)
    if (current.length > 0 && currentChars + extra > maxChars) flush()
    currentChars += unitChars(unit) + (current.length > 0 ? SEPARATOR_CHARS : 0)
    current.push(...unit)
  }

  for (const unit of units) add(unit)
  flush()
  return { sections, splitSegments }
}
