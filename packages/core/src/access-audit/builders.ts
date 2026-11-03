import { createHash } from "node:crypto"
import type { GateAuditRecordRequest } from "@eido/schemas"
import {
  CONTENT_COPY_SOURCES,
  INFERENCE_TASKS,
  INSTRUCTION_TYPES,
  type ContentCopySourceKind,
  type InferenceTask,
  type InstructionType,
} from "./types"

const HEX64 = /^[0-9a-f]{64}$/
const MODEL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex")
}

export function buildDocumentOpenDetail(input: {
  documentSha256: string
}): GateAuditRecordRequest {
  const hash = input.documentSha256.toLowerCase()
  if (!HEX64.test(hash)) {
    throw new Error(
      "documentSha256 must be a 64-character lowercase hex string"
    )
  }
  return {
    action: "access.document_open",
    subjectHash: hash,
    beforeHash: null,
    afterHash: null,
  }
}

export function buildInferenceUseDetail(input: {
  task: InferenceTask
  modelId?: string
}): GateAuditRecordRequest {
  if (!INFERENCE_TASKS.includes(input.task)) {
    throw new Error(`Invalid inference task: ${String(input.task)}`)
  }
  if (input.modelId !== undefined && !MODEL_ID_PATTERN.test(input.modelId)) {
    throw new Error(`Invalid model identifier: ${input.modelId}`)
  }
  const subjectHash = sha256(
    JSON.stringify([
      "eido.access-audit.v1",
      "inference_use",
      input.task,
      input.modelId ?? "local",
    ])
  )
  return {
    action: "access.inference_use",
    subjectHash,
    beforeHash: null,
    afterHash: null,
  }
}

export function buildContentCopyDetail(input: {
  sourceKind: ContentCopySourceKind
}): GateAuditRecordRequest {
  if (!CONTENT_COPY_SOURCES.includes(input.sourceKind)) {
    throw new Error(
      `Invalid content copy source kind: ${String(input.sourceKind)}`
    )
  }
  const subjectHash = sha256(
    JSON.stringify(["eido.access-audit.v1", "content_copy", input.sourceKind])
  )
  return {
    action: "access.content_copy",
    subjectHash,
    beforeHash: null,
    afterHash: null,
  }
}

export function buildInstructionChangeDetail(input: {
  instructionType: InstructionType
}): GateAuditRecordRequest {
  if (!INSTRUCTION_TYPES.includes(input.instructionType)) {
    throw new Error(
      `Invalid instruction type: ${String(input.instructionType)}`
    )
  }
  const subjectHash = sha256(
    JSON.stringify([
      "eido.access-audit.v1",
      "instruction_change",
      input.instructionType,
    ])
  )
  return {
    action: "access.instruction_change",
    subjectHash,
    beforeHash: null,
    afterHash: null,
  }
}
