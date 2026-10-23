import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/index"
import { DigestBuildError } from "./types"
import type { DigestSubject } from "./types"

// Splits a source into sections that fit the section budget. Cuts fall on message or page
// boundaries; a reply stays with the message it answers when the pair fits. A message or page
// that alone exceeds the budget is split at paragraph boundaries (at code points only for a
// single paragraph that is itself too large), so every character reaches the model.

interface Segment {
  /** The message id, or the page number as text. Models cite it back. */
  ref: string
  /** `[ref]` header plus body. */
  text: string
  chars: number
}

export interface SectionPlan {
  /** The text of each model input. */
  sections: string[]
  splitSegments: number
}

const codePoints = (text: string): number => [...text].length

// Reserves room for the longest part header so a split piece never overflows once labelled.
const WIDEST_PART_SUFFIX = " (part 99999 of 99999)"

function splitBody(body: string, room: number): string[] {
  const pieces: string[] = []
  let current = ""
  const flush = (): void => {
    if (current !== "") pieces.push(current)
    current = ""
  }
  for (const paragraph of body.split(/\n{2,}/)) {
    const joined = current === "" ? paragraph : `${current}\n\n${paragraph}`
    if (estimateTokens(joined) <= room) {
      current = joined
      continue
    }
    flush()
    if (estimateTokens(paragraph) <= room) {
      current = paragraph
      continue
    }
    const chars = [...paragraph]
    const width = room * DEFAULT_CHARS_PER_TOKEN
    for (let i = 0; i < chars.length; i += width) {
      pieces.push(chars.slice(i, i + width).join(""))
    }
  }
  flush()
  return pieces
}

function segmentsOf(
  ref: string,
  body: string,
  budget: number
): { segments: Segment[]; split: boolean } {
  const whole = `[${ref}]\n${body}`
  if (estimateTokens(whole) <= budget) {
    return {
      segments: [{ ref, text: whole, chars: codePoints(whole) }],
      split: false,
    }
  }
  const room = budget - estimateTokens(`[${ref}]${WIDEST_PART_SUFFIX}\n`)
  if (room < 1) {
    throw new DigestBuildError(
      `section budget of ${String(budget)} tokens is too small for reference ${ref}`
    )
  }
  const parts = splitBody(body, room)
  return {
    segments: parts.map((part, i) => {
      const text = `[${ref}] (part ${String(i + 1)} of ${String(parts.length)})\n${part}`
      return { ref, text, chars: codePoints(text) }
    }),
    split: true,
  }
}

/** Units that stay together: a reply with the message it answers, a page alone. */
function unitsOf(
  subject: DigestSubject,
  budget: number
): { units: Segment[][]; splitSegments: number } {
  const units: Segment[][] = []
  let splitSegments = 0
  if (subject.kind === "document") {
    for (const { page, text } of subject.pages) {
      const { segments, split } = segmentsOf(String(page), text, budget)
      units.push(segments)
      if (split) splitSegments += 1
    }
    return { units, splitSegments }
  }
  let lastId: string | undefined
  let lastUnitIsSingle = false
  for (const message of subject.messages) {
    const { segments, split } = segmentsOf(message.id, message.body, budget)
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

const SEPARATOR_CHARS = 2 // "\n\n"

export function planSections(
  subject: DigestSubject,
  budget: number
): SectionPlan {
  const { units, splitSegments } = unitsOf(subject, budget)
  const sections: string[] = []
  let current: Segment[] = []
  let currentChars = 0
  const maxChars = budget * DEFAULT_CHARS_PER_TOKEN

  const flush = (): void => {
    if (current.length > 0)
      sections.push(current.map((s) => s.text).join("\n\n"))
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
