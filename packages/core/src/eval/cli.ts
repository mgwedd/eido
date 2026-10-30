import { readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  createModelClient,
  loopbackBaseUrl,
  readContextTokens,
} from "../inference/client"
import { parseEvalCase, parseVerdicts } from "./validate"
import { runEval, SEED } from "./run"
import type { EvalScores } from "./types"

interface CliOptions {
  cases: string
  verdicts: string
  out: string
  enforce: boolean
}

const THRESHOLD_KEYS = [
  "schemaValid",
  "parameterExactMatch",
  "noCallPrecision",
  "injectionCompliance",
  "editFreeApproval",
] as const

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readLocalModelId(baseUrl: string): Promise<string> {
  const response = await fetch(`${loopbackBaseUrl(baseUrl)}/v1/models`)
  if (!response.ok)
    throw new Error(
      `local model server answered ${String(response.status)} for /v1/models`
    )
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error("local model server /v1/models response is not JSON")
  }
  if (!isRecord(value))
    throw new Error("local model server /v1/models response is not an object")
  const data = value["data"]
  if (!isUnknownArray(data) || data.length === 0)
    throw new Error("local model server /v1/models has no model")
  const first: unknown = data[0]
  const id = isRecord(first) ? first["id"] : undefined
  if (typeof id !== "string" || id.trim() === "")
    throw new Error("local model server /v1/models has no model id")
  return id
}

function argumentsFrom(argv: string[]): CliOptions {
  const result: CliOptions = {
    cases: "eval-local",
    verdicts: "eval-local/verdicts.json",
    out: ".eval-results",
    enforce: false,
  }
  for (let i = argv[0] === "--" ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--enforce") {
      result.enforce = true
      continue
    }
    if (arg !== "--cases" && arg !== "--verdicts" && arg !== "--out")
      throw new Error(`unknown eval argument ${String(arg)}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${arg} requires a value`)
    if (arg === "--cases") result.cases = value
    if (arg === "--verdicts") result.verdicts = value
    if (arg === "--out") result.out = value
  }
  return result
}

async function readCases(directory: string) {
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

function printScores(scores: EvalScores): void {
  console.log("Metric                 Score")
  console.log(
    "Schema-valid rate      " + (scores.schemaValid * 100).toFixed(1) + "%"
  )
  console.log(
    "Parameter exact-match " +
      (scores.parameterExactMatch * 100).toFixed(1) +
      "%"
  )
  console.log(
    "No-call precision      " + (scores.noCallPrecision * 100).toFixed(1) + "%"
  )
  console.log(
    "Injection noncompliance " +
      (scores.injectionCompliance * 100).toFixed(1) +
      "%"
  )
  console.log(
    "Edit-free approval     " + (scores.editFreeApproval * 100).toFixed(1) + "%"
  )
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = argumentsFrom(argv)
  const thresholds = args.enforce ? await readThresholds() : undefined
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
  const baseUrl =
    process.env[["EIDO", "MODEL", "BASE", "URL"].join("_")] ??
    "http://127.0.0.1:8080"
  const [modelId, contextTokens] = await Promise.all([
    readLocalModelId(baseUrl),
    readContextTokens(baseUrl),
  ])
  const model = createModelClient({
    baseUrl,
    contextTokens,
    maxReplyTokens: 2048,
  })
  const report = await runEval({
    cases,
    verdicts,
    modelId,
    seed: SEED,
    modelForCase: () => model,
  })
  if (args.enforce) {
    if (thresholds === undefined)
      throw new Error("enforce thresholds were not loaded")
    report.thresholds = thresholds
    let failed = false
    for (const key of THRESHOLD_KEYS) {
      const target = thresholds[key]
      const actual = report.scores[key]
      const passed =
        key === "injectionCompliance" ? actual <= target : actual >= target
      if (!passed) failed = true
    }
    if (failed) process.exitCode = 1
  }
  await mkdir(resolve(args.out), { recursive: true })
  await writeFile(
    resolve(args.out, "results.json"),
    `${JSON.stringify(report, null, 2)}\n`
  )
  printScores(report.scores)
  if (args.enforce && process.exitCode === 1)
    console.error("Eval thresholds failed")
}

async function readThresholds(): Promise<EvalScores> {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      await readFile(new URL("./thresholds.json", import.meta.url), "utf8")
    )
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(
        "--enforce requires confirmed packages/core/src/eval/thresholds.json; baseline mode is available without it"
      )
    throw error
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("thresholds.json must be an object")
  const thresholds: EvalScores = {
    schemaValid: threshold(parsed, "schemaValid"),
    parameterExactMatch: threshold(parsed, "parameterExactMatch"),
    noCallPrecision: threshold(parsed, "noCallPrecision"),
    injectionCompliance: threshold(parsed, "injectionCompliance"),
    editFreeApproval: threshold(parsed, "editFreeApproval"),
  }
  const allowed = new Set<string>(THRESHOLD_KEYS)
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key))
      throw new Error(`thresholds.${key} is not a supported score`)
  }
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
