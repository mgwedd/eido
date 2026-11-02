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
  cases: CaseDiff[]
}

/** One model to evaluate: a loopback llama-server, already running or started by the runner. */
export interface EvalCandidate {
  /** Names the candidate in results and log files: lowercase letters, digits, `.`, `-`, `_`. */
  name: string
  baseUrl: string
  /** Recorded in results as given, for example "QAT Q4_0" or "Q4_K_M". */
  quantization?: string
  /** Sent as `chat_template_kwargs` on `/apply-template`, e.g. `{ "enable_thinking": false }`. */
  chatTemplateKwargs?: Record<string, unknown>
  /**
   * Start the server for this candidate only, so one model is loaded at a time: the runner spawns
   * `command` (no shell), waits for `GET /health` to answer 200, runs the cases and stops it.
   */
  server?: { command: string[]; readyTimeoutSeconds?: number }
}

interface CandidateInfo {
  name: string
  quantization?: string
  chatTemplateKwargs?: Record<string, unknown>
}

export type CandidateResult =
  | (CandidateInfo & {
      status: "ran"
      modelId: string
      scores: EvalScores
      /** Present in enforce mode: every score met its threshold. */
      passed?: boolean
      cases: CaseDiff[]
    })
  | (CandidateInfo & { status: "failed"; error: string })

/** What `results.json` holds. */
export interface EvalResults {
  seed: number
  temperature: 0
  enforced: boolean
  thresholds?: EvalScores
  candidates: CandidateResult[]
}

export interface EvalOptions {
  cases: EvalCase[]
  verdicts: Verdicts
  modelId: string
  seed: number
  modelForCase: (testCase: EvalCase) => ModelClient
  onProposal?: (intent: Intent) => void
}
