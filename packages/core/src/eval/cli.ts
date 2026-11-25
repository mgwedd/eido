import { readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  connectModelClient,
  readContextTokens,
  readModelId,
} from "../inference/client"
import { defaultCandidate, parseCandidates, parseCliOptions } from "./config"
import { startServer } from "./server"
import type { RunningServer } from "./server"
import { parseEvalCase, parseVerdicts } from "./validate"
import { runEval } from "./run"
import type {
  CandidateResult,
  EvalCandidate,
  EvalCase,
  EvalResults,
  EvalScores,
  EvalThresholds,
  Verdicts,
} from "./types"

// The eval runner (issue #28). It runs the owner's local cases through the real proposal path
// against one or more local llama-server candidates and writes results.json:
//
//   pnpm --filter @eido/core eval -- --cases <dir> [--verdicts <file>] [--out <dir>]
//     [--candidates <file>] [--seed <n>] [--enforce]
//
// Baseline mode (the default) reports every score and exits 0 unless a candidate could not run.
// `--enforce` also needs the confirmed thresholds.json and exits 1 when a score misses its
// threshold. thresholds.json holds only the confirmed targets (#28: schemaValid and
// parameterExactMatch); a score with no threshold is reported and never enforced.

const THRESHOLD_KEYS = [
  "schemaValid",
  "parameterExactMatch",
  "noCallPrecision",
  "injectionCompliance",
  "editFreeApproval",
] as const

const MAX_REPLY_TOKENS = 2048

type Env = Readonly<Record<string, string | undefined>>

async function readCases(directory: string): Promise<EvalCase[]> {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".json") && file !== "verdicts.json")
    .sort()
  return Promise.all(
    files.map(async (file) => {
      const raw: unknown = JSON.parse(
        await readFile(join(directory, file), "utf8")
      )
      return parseEvalCase(raw, join(directory, file))
    })
  )
}

/** True when every score that has a threshold meets it; scores without one are not checked. */
export function meets(scores: EvalScores, thresholds: EvalThresholds): boolean {
  return THRESHOLD_KEYS.every((key) => {
    const target = thresholds[key]
    if (target === undefined) return true
    return key === "injectionCompliance"
      ? scores[key] <= target
      : scores[key] >= target
  })
}

async function runCandidate(
  candidate: EvalCandidate,
  cases: EvalCase[],
  verdicts: Verdicts,
  seed: number,
  out: string
): Promise<CandidateResult> {
  const info = {
    name: candidate.name,
    ...(candidate.quantization === undefined
      ? {}
      : { quantization: candidate.quantization }),
    ...(candidate.chatTemplateKwargs === undefined
      ? {}
      : { chatTemplateKwargs: candidate.chatTemplateKwargs }),
  }
  let server: RunningServer | undefined
  try {
    if (candidate.server !== undefined) {
      server = await startServer({
        baseUrl: candidate.baseUrl,
        command: candidate.server.command,
        logFile: join(out, `${candidate.name}.server.log`),
        ...(candidate.server.readyTimeoutSeconds === undefined
          ? {}
          : { readyTimeoutSeconds: candidate.server.readyTimeoutSeconds }),
      })
    }
    const [modelId, contextTokens] = await Promise.all([
      readModelId(candidate.baseUrl),
      readContextTokens(candidate.baseUrl),
    ])
    const model = await connectModelClient({
      baseUrl: candidate.baseUrl,
      contextTokens,
      maxReplyTokens: MAX_REPLY_TOKENS,
      ...(candidate.chatTemplateKwargs === undefined
        ? {}
        : { chatTemplateKwargs: candidate.chatTemplateKwargs }),
    })
    const report = await runEval({
      cases,
      verdicts,
      modelId,
      seed,
      modelForCase: () => model,
    })
    return {
      ...info,
      status: "ran",
      modelId: report.modelId,
      scores: report.scores,
      cases: report.cases,
    }
  } catch (error) {
    return {
      ...info,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await server?.stop()
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/** The printed table: one row per candidate, then the ids of each candidate's failing cases. */
export function formatTable(results: EvalResults): string {
  const header = [
    "Candidate",
    "Model",
    "Schema-valid",
    "Exact-match",
    "No-call",
    "Injection (lower is better)",
    "Edit-free",
    ...(results.enforced ? ["Result"] : []),
  ]
  const rows = results.candidates.map((c) =>
    c.status === "failed"
      ? [c.name, `could not run: ${c.error}`]
      : [
          c.name,
          c.modelId,
          percent(c.scores.schemaValid),
          percent(c.scores.parameterExactMatch),
          percent(c.scores.noCallPrecision),
          percent(c.scores.injectionCompliance),
          percent(c.scores.editFreeApproval),
          ...(c.passed === undefined ? [] : [c.passed ? "pass" : "fail"]),
        ]
  )
  const lines = [header, ...rows].map((row) => row.join(" | "))
  if (results.thresholds !== undefined) {
    const t = results.thresholds
    const target = (key: keyof EvalScores, bound: ">=" | "<="): string =>
      t[key] === undefined ? "not enforced" : `${bound} ${percent(t[key])}`
    lines.push(
      [
        "Thresholds",
        "",
        target("schemaValid", ">="),
        target("parameterExactMatch", ">="),
        target("noCallPrecision", ">="),
        target("injectionCompliance", "<="),
        target("editFreeApproval", ">="),
        "",
      ].join(" | ")
    )
  }
  for (const c of results.candidates) {
    if (c.status !== "ran") continue
    const failing = c.cases
      .filter(
        (d) =>
          d.exactMatch === false ||
          d.noCallCorrect === false ||
          d.injectionCompliant === false ||
          !d.firstAttemptSchemaValid
      )
      .map((d) => d.id)
    if (failing.length > 0)
      lines.push(`${c.name}: cases to read: ${failing.join(", ")}`)
  }
  return `${lines.join("\n")}\n`
}

const THRESHOLDS_FILE = new URL("./thresholds.json", import.meta.url)

export async function main(
  argv = process.argv.slice(2),
  env: Env = process.env,
  thresholdsFile: URL = THRESHOLDS_FILE
): Promise<EvalResults> {
  const args = parseCliOptions(argv, env)
  const thresholds = args.enforce
    ? await readThresholds(thresholdsFile)
    : undefined
  const candidates =
    args.candidates === undefined
      ? [defaultCandidate(env)]
      : parseCandidates(
          JSON.parse(await readFile(resolve(args.candidates), "utf8")),
          args.candidates
        )
  const cases = await readCases(resolve(args.cases))
  if (cases.length === 0)
    throw new Error(`no case JSON files found in ${args.cases}`)
  const verdicts = parseVerdicts(
    JSON.parse(await readFile(resolve(args.verdicts), "utf8")),
    args.verdicts
  )
  for (const testCase of cases) {
    if (verdicts[testCase.id] === undefined)
      throw new Error(`${args.verdicts}.${testCase.id}: verdict is required`)
  }
  const out = resolve(args.out)
  await mkdir(out, { recursive: true })
  const ran: CandidateResult[] = []
  for (const candidate of candidates) {
    const result = await runCandidate(
      candidate,
      cases,
      verdicts,
      args.seed,
      out
    )
    if (thresholds !== undefined && result.status === "ran")
      result.passed = meets(result.scores, thresholds)
    ran.push(result)
  }
  const results: EvalResults = {
    seed: args.seed,
    temperature: 0,
    enforced: args.enforce,
    ...(thresholds === undefined ? {} : { thresholds }),
    candidates: ran,
  }
  await writeFile(
    join(out, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`
  )
  process.stdout.write(formatTable(results))
  if (ran.some((c) => c.status === "failed" || c.passed === false))
    process.exitCode = 1
  return results
}

async function readThresholds(file: URL): Promise<EvalThresholds> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(
        "--enforce requires confirmed packages/core/src/eval/thresholds.json; baseline mode is available without it"
      )
    throw error
  }
  return parseThresholds(parsed)
}

/**
 * The confirmed targets, each a share from 0 to 1, for at least one of the five scores; any other
 * key is refused. A score left out is reported but not enforced.
 */
export function parseThresholds(parsed: unknown): EvalThresholds {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("thresholds.json must be an object")
  const allowed = new Set<string>(THRESHOLD_KEYS)
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key))
      throw new Error(`thresholds.${key} is not a supported score`)
  }
  const thresholds: EvalThresholds = {}
  for (const key of THRESHOLD_KEYS) {
    if (Reflect.has(parsed, key)) thresholds[key] = threshold(parsed, key)
  }
  if (Object.keys(thresholds).length === 0)
    throw new Error("thresholds.json must set at least one score")
  return thresholds
}

function threshold(value: object, key: keyof EvalScores): number {
  const target: unknown = Reflect.get(value, key)
  if (
    typeof target !== "number" ||
    !Number.isFinite(target) ||
    target < 0 ||
    target > 1
  )
    throw new Error(`thresholds.${key} must be a number from 0 to 1`)
  return target
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
