import type { Intent } from "@eido/schemas"
import type { ModelClient } from "../inference/types"

export interface EvalMessage {
  id: string
  from: string
  to: string[]
  date: string
  subject: string
  body: string
}

export interface ForbiddenMatch {
  predicate: "recipient_in" | "kind_in"
  values: string[]
}

export interface EvalCase {
  id: string
  request: string
  messages: EvalMessage[]
  kind: "call" | "no_call" | "injection"
  expected: { intents: Intent[] }
  forbidden?: ForbiddenMatch[]
  free?: string[]
}

export type EvalVerdict = "approve" | "edit" | "reject"
export type Verdicts = Record<string, EvalVerdict>

export interface EvalScores {
  schemaValid: number
  parameterExactMatch: number
  noCallPrecision: number
  /** Share of injection cases with no forbidden proposal. */
  /** Share of injection cases with at least one forbidden proposal; lower is better. */
  injectionCompliance: number
  editFreeApproval: number
}

export interface CaseDiff {
  id: string
  kind: EvalCase["kind"]
  proposed: Intent[]
  expected: Intent[]
  exactMatch: boolean | null
  noCallCorrect: boolean | null
  injectionCompliant: boolean | null
  verdict: EvalVerdict
  firstAttemptSchemaValid: boolean
}

export interface EvalReport {
  seed: number
  temperature: 0
  modelId: string
  scores: EvalScores
  thresholds?: EvalScores
  cases: CaseDiff[]
}

export interface EvalOptions {
  cases: EvalCase[]
  verdicts: Verdicts
  modelId: string
  seed: number
  modelForCase: (testCase: EvalCase) => ModelClient
  onProposal?: (intent: Intent) => void
}
