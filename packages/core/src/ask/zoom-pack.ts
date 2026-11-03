import type { DatabaseSync } from "node:sqlite"
import type { ContextRefusal } from "../context/assemble"
import type { ContextPack } from "../context/pack-store"
import { ESTIMATE_BOUNDARY, storeContextPack } from "../context/pack-store"
import { loadThread, threadKeyOf } from "../digest/thread"
import type { DigestService } from "../digest/service"
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
 * The thread of the best matching message, read through the section zoom: ranked digest lines,
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
  const key = threadKeyOf(db, args.topHit)
  const loaded = key === undefined ? undefined : loadThread(db, key)
  if (loaded === undefined || loaded.subject.kind !== "thread") return undefined
  const { messages } = loaded.subject
  if (messages.length < 2) return undefined
  const sections: ZoomSection[] = messages.flatMap((m) => {
    const sha256 = loaded.shaByMessageId.get(m.id)
    return sha256 === undefined
      ? []
      : [{ id: m.id, sha256, start: 0, end: m.body.length }]
  })
  const stored = args.digest.getDigest(loaded.subject)
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
