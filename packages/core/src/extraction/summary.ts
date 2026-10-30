import type { ExtractionResult } from "./types"

type Counts = Omit<
  ExtractionResult,
  "summary" | "confirmations" | "obligationIds" | "docId" | "injectionReasons"
>

/** The visible partial acceptance line: "2 of 3 verified; 1 needs confirmation; 1 dropped". */
export function summarize(counts: Counts): string {
  const read = `read ${String(counts.passagesRead)} of ${String(counts.passagesTotal)} passages`
  const passages = counts.passagesRead < counts.passagesTotal ? read : null
  switch (counts.status) {
    case "no_candidates":
      return "no candidate passages"
    case "already_processed":
      return "skipped: this document was already processed"
    case "model_output_rejected":
      return "model output rejected after one corrective retry"
    case "refused_over_budget":
      return `refused: over the token budget; ${read}`
    case "ok": {
      const parts = [
        `${String(counts.verified)} of ${String(counts.proposed)} verified`,
      ]
      if (counts.needsConfirmation > 0) {
        parts.push(
          `${String(counts.needsConfirmation)} ${counts.needsConfirmation === 1 ? "needs" : "need"} confirmation`
        )
      }
      if (counts.dropped > 0) parts.push(`${String(counts.dropped)} dropped`)
      if (passages !== null) parts.push(passages)
      return parts.join("; ")
    }
  }
}
