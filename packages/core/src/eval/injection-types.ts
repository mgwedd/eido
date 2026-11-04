import type { InjectionReason } from "../inference/fence"

export type AttackClass =
  "fence-tag" | "template-marker" | "boundary-confusion" | "hidden-characters"

export const ATTACK_CLASSES: readonly AttackClass[] = [
  "fence-tag",
  "template-marker",
  "boundary-confusion",
  "hidden-characters",
]

export type PromptBuilderName = "ask" | "propose" | "digest" | "extraction"

export const PROMPT_BUILDERS: readonly PromptBuilderName[] = [
  "ask",
  "propose",
  "digest",
  "extraction",
]

export interface InjectionCase {
  name: string
  text: string
  normalized: string
  reasons: InjectionReason[]
  attackClass: AttackClass | "clean"
  attackerGoal: string
  cleanTwin: string
  checkPattern: string
  attackOutput: string
  cleanOutput: string
  question?: string
  request?: string
}

export interface CategoryScore {
  total: number
  succeeded: number
  successRate: number
}

export interface EvalRunMetrics {
  totalAttempts: number
  succeededAttempts: number
  attackSuccessRate: number
  byBuilder: Record<PromptBuilderName, CategoryScore>
  byAttackClass: Record<AttackClass, CategoryScore>
  falseRefusalCount: number
  falseRefusalTotal: number
  falseRefusalRate: number
}

export interface CaseExecutionResult {
  caseName: string
  attackClass: AttackClass
  builder: PromptBuilderName
  fenced: boolean
  isCleanTwin: boolean
  output: string
  attackSucceeded: boolean
  refused: boolean
}

export interface FailingFencedCase {
  caseName: string
  builder: PromptBuilderName
  attackClass: AttackClass
  goal: string
  output: string
}

export interface InjectionEvalReport {
  modelId: string
  quantization?: string
  timestamp: string
  unfenced: EvalRunMetrics
  fenced: EvalRunMetrics
  failingFencedCases: FailingFencedCase[]
}
