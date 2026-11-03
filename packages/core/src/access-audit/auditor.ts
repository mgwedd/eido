import type { GateAuditRecordRequest } from "@eido/schemas"
import {
  buildContentCopyDetail,
  buildDocumentOpenDetail,
  buildInferenceUseDetail,
  buildInstructionChangeDetail,
} from "./builders"
import { BoundedDeduplicator } from "./dedup"
import {
  type AccessAuditorOptions,
  type ContentCopySourceKind,
  type FailurePolicy,
  type InferenceTask,
  type InstructionType,
  type RecordOptions,
  type RecordResult,
} from "./types"

export class AccessAuditError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = "AccessAuditError"
  }
}

export interface AccessAuditor {
  recordDocumentOpen(
    input: { documentSha256: string },
    options?: RecordOptions
  ): Promise<RecordResult>

  recordInferenceUse(
    input: { task: InferenceTask; modelId?: string },
    options?: RecordOptions
  ): Promise<RecordResult>

  recordContentCopy(
    input: { sourceKind: ContentCopySourceKind },
    options?: RecordOptions
  ): Promise<RecordResult>

  recordInstructionChange(
    input: { instructionType: InstructionType },
    options?: RecordOptions
  ): Promise<RecordResult>
}

export function createAccessAuditor(
  options: AccessAuditorOptions
): AccessAuditor {
  const dedupe = new BoundedDeduplicator(
    options.dedupeWindowMs ?? 5 * 60 * 1000,
    options.clock
  )
  const defaultPolicy: FailurePolicy = options.failurePolicy ?? "fail-closed"

  async function emit(
    entry: GateAuditRecordRequest,
    policy: FailurePolicy
  ): Promise<RecordResult> {
    try {
      const res = (await options.audit(entry)) as { seq?: number } | undefined
      return { emitted: true, seq: res?.seq }
    } catch (error) {
      options.onError?.(error, entry)
      if (policy === "fail-closed") {
        throw new AccessAuditError(
          `Failed to append access audit record for ${entry.action}`,
          error
        )
      }
      return { emitted: false }
    }
  }

  return {
    async recordDocumentOpen(input, opts) {
      const detail = buildDocumentOpenDetail(input)
      if (!dedupe.shouldEmit(detail.subjectHash)) {
        return { emitted: false }
      }
      return emit(detail, opts?.failurePolicy ?? defaultPolicy)
    },

    async recordInferenceUse(input, opts) {
      const detail = buildInferenceUseDetail(input)
      return emit(detail, opts?.failurePolicy ?? defaultPolicy)
    },

    async recordContentCopy(input, opts) {
      const detail = buildContentCopyDetail(input)
      return emit(detail, opts?.failurePolicy ?? defaultPolicy)
    },

    async recordInstructionChange(input, opts) {
      const detail = buildInstructionChangeDetail(input)
      return emit(detail, opts?.failurePolicy ?? defaultPolicy)
    },
  }
}
