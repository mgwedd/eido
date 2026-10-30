import type { ExtractedFields, SourceSpan } from "@eido/schemas"
import type { InjectionReason } from "../inference/fence"
import type { EntityKind } from "../profile/types"

export type ExtractionFieldName = keyof ExtractedFields

export type ExtractionInput =
  | {
      docId: string
      schema: string
      status: "extracted"
      fields: ExtractedFields
      /** One confidence (0..1) per field present in `fields`, compared with the threshold on its own. */
      confidence: Partial<Record<ExtractionFieldName, number>>
      model: string
      createdAt: string
    }
  | {
      /** The prefilter or the model found nothing: no fields and no confidence rows. */
      docId: string
      schema: string
      status: "processed_empty"
      /** `none` when no model was called. */
      model: string
      createdAt: string
    }

export type ObligationStatus = "open" | "done" | "dismissed"
export type ObligationDirection = "owed" | "waiting"

export interface ObligationInput {
  entityId: string
  party?: string
  action: string
  /** YYYY-MM-DD. */
  dueAt?: string
  status: ObligationStatus
  docId: string
  span: SourceSpan
  injectionSuspected?: boolean
  injectionReasons?: InjectionReason[]
  direction?: ObligationDirection
  threadId?: string
  anchorMessageId?: string
}

export interface Obligation {
  id: number
  entity: { id: string; kind: EntityKind; name: string; tag: string }
  party: string | null
  action: string
  dueAt: string | null
  status: ObligationStatus
  docId: string
  span: SourceSpan
  injectionSuspected: boolean
  injectionReasons: InjectionReason[]
  direction: ObligationDirection | null
  threadId: string | null
  anchorMessageId: string | null
  resolutionReason: "replied" | null
}

export interface ObligationFilter {
  entityId?: string
  status?: ObligationStatus
  /** YYYY-MM-DD, exclusive. Obligations with no due date are left out when set. */
  dueBefore?: string
}

export interface ObligationSource {
  docId: string
  blobPath: string | null
  span: SourceSpan
  injectionSuspected: boolean
  injectionReasons: InjectionReason[]
}

export type LinkEndpoint =
  `doc:${string}` | `obl:${number}` | `ent:${string}` | `party:${string}`

export type LinkKind =
  | "thread"
  | "reply_to"
  | "attachment_of"
  | "references"
  | "supersedes"
  | "about_party"

export interface Link {
  src: LinkEndpoint
  dst: LinkEndpoint
  kind: LinkKind
  /** 1 for header edges; below 1 for matched edges. */
  confidence: number
  /** `header:<field>` for deterministic edges, `match` for matched ones. */
  origin: `header:${string}` | "match"
}
