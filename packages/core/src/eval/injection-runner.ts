import type { ModelClient } from "../inference/types"
import { BUILDERS } from "./injection-builders"
import {
  calculateRunMetrics,
  checkAttackSuccess,
  checkRefusal,
} from "./injection-predicates"
import { PROMPT_BUILDERS } from "./injection-types"
import type {
  CaseExecutionResult,
  FailingFencedCase,
  InjectionCase,
  InjectionEvalReport,
  PromptBuilderName,
} from "./injection-types"

export interface InjectionRunnerOptions {
  builders?: readonly PromptBuilderName[]
  modelId?: string
  quantization?: string
  onProgress?: (progress: {
    completed: number
    total: number
    phase: "unfenced" | "fenced" | "clean-unfenced" | "clean-fenced"
    caseName: string
    builder: PromptBuilderName
  }) => void
}

export async function runInjectionEval(
  cases: readonly InjectionCase[],
  client: ModelClient,
  options: InjectionRunnerOptions = {}
): Promise<InjectionEvalReport> {
  const activeBuilders = options.builders ?? PROMPT_BUILDERS
  const adversarialCases = cases.filter((c) => c.attackClass !== "clean")

  const unfencedHostile: CaseExecutionResult[] = []
  const fencedHostile: CaseExecutionResult[] = []
  const unfencedClean: CaseExecutionResult[] = []
  const fencedClean: CaseExecutionResult[] = []
  const failingFencedCases: FailingFencedCase[] = []

  const totalOps = adversarialCases.length * activeBuilders.length * 4
  let completedOps = 0

  for (const builder of activeBuilders) {
    const build = BUILDERS[builder]

    for (const testCase of adversarialCases) {
      const attackClass = testCase.attackClass as Exclude<
        InjectionCase["attackClass"],
        "clean"
      >

      // 1. Unfenced hostile
      options.onProgress?.({
        completed: completedOps,
        total: totalOps,
        phase: "unfenced",
        caseName: testCase.name,
        builder,
      })
      const unfencedReq = build(testCase.text, {
        fenced: false,
        ...(testCase.question === undefined
          ? {}
          : { question: testCase.question }),
        ...(testCase.request === undefined
          ? {}
          : { request: testCase.request }),
      })
      const unfencedRes = await client.complete(unfencedReq)
      const unfencedSuccess = checkAttackSuccess(testCase, unfencedRes.text)
      unfencedHostile.push({
        caseName: testCase.name,
        attackClass,
        builder,
        fenced: false,
        isCleanTwin: false,
        output: unfencedRes.text,
        attackSucceeded: unfencedSuccess,
        refused: checkRefusal(unfencedRes.text),
      })
      completedOps += 1

      // 2. Fenced hostile
      options.onProgress?.({
        completed: completedOps,
        total: totalOps,
        phase: "fenced",
        caseName: testCase.name,
        builder,
      })
      const fencedReq = build(testCase.text, {
        fenced: true,
        ...(testCase.question === undefined
          ? {}
          : { question: testCase.question }),
        ...(testCase.request === undefined
          ? {}
          : { request: testCase.request }),
      })
      const fencedRes = await client.complete(fencedReq)
      const fencedSuccess = checkAttackSuccess(testCase, fencedRes.text)
      fencedHostile.push({
        caseName: testCase.name,
        attackClass,
        builder,
        fenced: true,
        isCleanTwin: false,
        output: fencedRes.text,
        attackSucceeded: fencedSuccess,
        refused: checkRefusal(fencedRes.text),
      })
      if (fencedSuccess) {
        failingFencedCases.push({
          caseName: testCase.name,
          builder,
          attackClass,
          goal: testCase.attackerGoal,
          output: fencedRes.text,
        })
      }
      completedOps += 1

      // 3. Unfenced clean twin
      options.onProgress?.({
        completed: completedOps,
        total: totalOps,
        phase: "clean-unfenced",
        caseName: testCase.name,
        builder,
      })
      const cleanUnfencedReq = build(testCase.cleanTwin, {
        fenced: false,
        ...(testCase.question === undefined
          ? {}
          : { question: testCase.question }),
        ...(testCase.request === undefined
          ? {}
          : { request: testCase.request }),
      })
      const cleanUnfencedRes = await client.complete(cleanUnfencedReq)
      unfencedClean.push({
        caseName: testCase.name,
        attackClass,
        builder,
        fenced: false,
        isCleanTwin: true,
        output: cleanUnfencedRes.text,
        attackSucceeded: false,
        refused: checkRefusal(cleanUnfencedRes.text),
      })
      completedOps += 1

      // 4. Fenced clean twin
      options.onProgress?.({
        completed: completedOps,
        total: totalOps,
        phase: "clean-fenced",
        caseName: testCase.name,
        builder,
      })
      const cleanFencedReq = build(testCase.cleanTwin, {
        fenced: true,
        ...(testCase.question === undefined
          ? {}
          : { question: testCase.question }),
        ...(testCase.request === undefined
          ? {}
          : { request: testCase.request }),
      })
      const cleanFencedRes = await client.complete(cleanFencedReq)
      fencedClean.push({
        caseName: testCase.name,
        attackClass,
        builder,
        fenced: true,
        isCleanTwin: true,
        output: cleanFencedRes.text,
        attackSucceeded: false,
        refused: checkRefusal(cleanFencedRes.text),
      })
      completedOps += 1
    }
  }

  const unfencedMetrics = calculateRunMetrics(unfencedHostile, unfencedClean)
  const fencedMetrics = calculateRunMetrics(fencedHostile, fencedClean)

  return {
    modelId: options.modelId ?? "unknown-model",
    ...(options.quantization === undefined
      ? {}
      : { quantization: options.quantization }),
    timestamp: new Date().toISOString(),
    unfenced: unfencedMetrics,
    fenced: fencedMetrics,
    failingFencedCases,
  }
}
