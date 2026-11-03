import type { GateAuditRecordRequest } from "@eido/schemas"

export const INFERENCE_TASKS = [
  "ask",
  "extraction",
  "summary",
  "brief",
] as const

export type InferenceTask = (typeof INFERENCE_TASKS)[number]

export const CONTENT_COPY_SOURCES = ["document", "obligation", "turn"] as const

export type ContentCopySourceKind = (typeof CONTENT_COPY_SOURCES)[number]

export const INSTRUCTION_TYPES = ["system", "custom", "rules"] as const

export type InstructionType = (typeof INSTRUCTION_TYPES)[number]

export type AccessAuditSink = (
  entry: GateAuditRecordRequest
) => Promise<unknown>

export type FailurePolicy = "fail-closed" | "fail-open"

export type AccessAuditorOptions = {
  audit: AccessAuditSink
  dedupeWindowMs?: number
  clock?: () => number
  onError?: (error: unknown, entry: GateAuditRecordRequest) => void
  failurePolicy?: FailurePolicy
}

export type RecordOptions = {
  failurePolicy?: FailurePolicy
}

export type RecordResult = {
  emitted: boolean
  seq?: number
}
