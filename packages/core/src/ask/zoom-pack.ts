import type { DatabaseSync } from "node:sqlite"
import type { ContextRefusal } from "../context/assemble"
import type { ContextPack } from "../context/pack-store"
import { ESTIMATE_BOUNDARY, storeContextPack } from "../context/pack-store"
import { loadThread, threadKeyOf } from "../digest/thread"
import type { DigestService } from "../digest/service"
import type { DigestSubject, DocumentPage } from "../digest/types"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"
import { fence, plainContent, toMaterial } from "../inference/fence"
import type { PromptPart } from "../inference/fence"
import { buildZoomPack } from "./pack"
import { selectZoomContext } from "./zoom"
import type { ZoomResult, ZoomSection } from "./zoom"

export interface ZoomedAsk {
  pack: ContextPack
  /** The placed digest lines as one labelled, fenced block; empty when none were placed. */
  summaryParts: PromptPart[]
  /** Fact lines about the sections read, computed by code. */
  facts: string[]
  zoom: ZoomResult
}

/** The widest the zoom fact lines can be, for the request's fixed-size estimate. */
export const ZOOM_FACTS_RESERVE = [
  "threadSections: 9999999999",
  "threadSectionsOmitted: 9999999999",
  "digestLines: 9999999999",
]

const SUMMARY_NOTE =
  "Digest summaries (written earlier by a model; they can miss things and are not quotable, so cite only the [M] tags of the passages below):\n"

const MAX_ROUNDS = 64

function summaryParts(zoom: ZoomResult): PromptPart[] {
  const lines = zoom.items.flatMap((item) =>
    item.kind === "summary"
      ? [`- ${item.text} [${item.cites.map((c) => c.sectionId).join(", ")}]`]
      : []
  )
  if (lines.length === 0) return []
  return [
    SUMMARY_NOTE,
    fence(toMaterial(lines.join("\n"), { source: "summary" })),
    "\n\n",
  ]
}

/**
 * What the zoom reads for the best matching document: its thread when it is one of several
 * messages, else its pages when it has several with stored offsets into the body. Undefined
 * otherwise. A page with no stored offsets is not a section: no range is guessed for it.
 */
function zoomSource(
  db: DatabaseSync,
  topHit: string
): { subject: DigestSubject; sections: ZoomSection[] } | undefined {
  const key = threadKeyOf(db, topHit)
  const loaded = key === undefined ? undefined : loadThread(db, key)
  if (
    loaded !== undefined &&
    loaded.subject.kind === "thread" &&
    loaded.subject.messages.length >= 2
  ) {
    return {
      subject: loaded.subject,
      sections: loaded.subject.messages.flatMap((m) => {
        const sha256 = loaded.shaByMessageId.get(m.id)
        return sha256 === undefined
          ? []
          : [{ id: m.id, sha256, start: 0, end: m.body.length }]
      }),
    }
  }
  if (loaded !== undefined) return undefined
  const rows = db
    .prepare(
      `SELECT page, text, start_offset, end_offset FROM document_pages
       WHERE sha256 = ? ORDER BY page`
    )
    .all(topHit)
  const pages: DocumentPage[] = []
  const sections: ZoomSection[] = []
  for (const row of rows) {
    const { page, text, start_offset: start, end_offset: end } = row
    if (typeof page !== "number" || typeof text !== "string") continue
    pages.push({ page, text })
    if (typeof start === "number" && typeof end === "number")
      sections.push({
        id: `${topHit}#${String(page)}`,
        sha256: topHit,
        start,
        end,
      })
  }
  if (pages.length < 2 || sections.length === 0) return undefined
  return {
    subject: { kind: "document", docSha256: topHit, pages },
    sections,
  }
}

/**
 * The thread or paged document of the best matching message, read through the section zoom: ranked digest lines,
 * then verified raw passages, all within `budgetTokens` as the request will really size them.
 * Undefined when the best match is not in a thread of several messages, so the caller reads it
 * the usual way. A refusal when nothing of the thread fits.
 */
export async function buildZoomedAsk(
  db: DatabaseSync,
  args: {
    topHit: string
    digest: Pick<DigestService, "getDigest">
    terms: ReadonlySet<string>
    existence: boolean
    budgetTokens: number
    charsPerToken?: number
  }
): Promise<ZoomedAsk | ContextRefusal | undefined> {
  const source = zoomSource(db, args.topHit)
  if (source === undefined) return undefined
  const { subject, sections } = source
  const stored = args.digest.getDigest(subject)
  const digest = "lines" in stored ? stored : undefined
  const charsPerToken = args.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN

  // The selector costs items as plain text; fences, headings and tags add to that. Re-select
  // with the excess taken off until the real parts fit.
  let room = args.budgetTokens
  let needed = args.budgetTokens + 1
  for (let round = 0; round < MAX_ROUNDS && room > 0; round++) {
    const zoom = selectZoomContext({
      db,
      sections,
      digest,
      terms: args.terms,
      budgetTokens: room,
      charsPerToken,
      existence: args.existence,
    })
    if (zoom.items.length === 0) break
    const pack = await buildZoomPack(db, zoom.items, charsPerToken, false)
    const parts = summaryParts(zoom)
    const actual =
      pack.tokenCount +
      estimateTokens(plainContent(parts, ESTIMATE_BOUNDARY), charsPerToken)
    if (actual <= args.budgetTokens) {
      await storeContextPack(db, pack)
      const omitted = zoom.coverage.filter((c) => c.omitted !== undefined)
      return {
        pack,
        summaryParts: parts,
        zoom,
        facts: [
          `threadSections: ${String(zoom.coverage.length)}`,
          `threadSectionsOmitted: ${String(omitted.length)}`,
          `digestLines: ${String(zoom.items.filter((i) => i.kind === "summary").length)}`,
        ],
      }
    }
    needed = actual
    room = Math.min(room - (actual - args.budgetTokens), zoom.tokens - 1)
  }
  return {
    refused: true,
    reason: "seed_too_large",
    seedTokens: needed,
    budgetTokens: args.budgetTokens,
  }
}
