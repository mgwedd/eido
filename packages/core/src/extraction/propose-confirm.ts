import type { ConfirmFieldIntent } from "@eido/schemas"
import type { IntentClient, IntentProposal } from "@eido/gate"
import { lookupOffset } from "../parsers/offsets"
import type { OffsetTable } from "../parsers/types"
import type { ConfirmCandidate } from "./types"

export interface ProposeConfirmOptions {
  documentTitle?: string
  documentSource?: string
  contextSources?: string[]
  contextPackId?: string
  offsets?: OffsetTable
}

export async function proposeConfirm(
  gate: Pick<IntentClient, "propose">,
  candidate: ConfirmCandidate,
  options?: ProposeConfirmOptions
): Promise<string> {
  const location =
    options?.offsets !== undefined
      ? lookupOffset(options.offsets, candidate.span.start)
      : null

  const proposal: IntentProposal = {
    intent: {
      kind: "confirm.field",
      args: {
        extractionId: String(candidate.extractionId),
        field: candidate.field,
        value: {
          raw: candidate.raw,
          ...(candidate.parsed !== undefined && candidate.parsed !== null
            ? {
                typed:
                  candidate.parsed as ConfirmFieldIntent["args"]["value"]["typed"],
              }
            : {}),
        },
        source: {
          docSha256: candidate.docId,
          ...(location?.messageId !== undefined
            ? { messageId: location.messageId }
            : {}),
          ...(location?.page !== undefined ? { page: location.page } : {}),
          ...(location?.line !== undefined ? { line: location.line } : {}),
          start: candidate.span.start,
          end: candidate.span.end,
        },
        confidence: candidate.confidence,
        threshold: candidate.threshold,
        ...(options?.documentTitle !== undefined
          ? { documentTitle: options.documentTitle }
          : {}),
        ...(options?.documentSource !== undefined
          ? { documentSource: options.documentSource }
          : {}),
        ...(options?.contextSources !== undefined
          ? { contextSources: options.contextSources }
          : {}),
        ...(options?.contextPackId !== undefined
          ? { contextPackId: options.contextPackId }
          : {}),
      },
    },
    origin: "reactive",
    ...(candidate.injectionSuspected
      ? { injection: { reasons: candidate.injectionReasons } }
      : {}),
  }

  const result = await gate.propose(proposal)
  if (result.state === "rejected") {
    throw new Error(
      `gate refused confirm.field proposal: ${result.reason ?? "rejected"}`
    )
  }
  return result.id
}
