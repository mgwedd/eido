import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  connectModelClient,
  readContextTokens,
  readModelId,
} from "../inference/client"
import { ASK_VARIANTS, loadAskCases, runAskEval } from "./ask-eval"
import type {
  AskCaseScore,
  AskEvalCase,
  AskEvalReport,
  AskVariant,
} from "./ask-eval"
import { DEFAULT_SEED, defaultCandidate, parseCandidates } from "./config"
import { startServer } from "./server"
import type { RunningServer } from "./server"
import type { EvalCandidate } from "./types"

// The Ask answer eval (issue #717): every candidate answers every case in fixtures/eval/ask with
// and without ANSWER_REMINDER, and the three scores are printed side by side.
//
//   pnpm --filter @eido/core eval-ask -- [--cases <file>] [--candidates <file>] [--out <dir>]
//
// It needs the owner's local llama-server candidates; it never runs in CI.

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.."
)
const DEFAULT_CASES = join(REPO_ROOT, "fixtures", "eval", "ask", "cases.json")
const MAX_REPLY_TOKENS = 1024

type Env = Readonly<Record<string, string | undefined>>

export interface AskCliOptions {
  cases: string
  out: string
  candidates?: string
}

export function parseAskCliOptions(
  argv: readonly string[],
  env: Env = process.env
): AskCliOptions {
  const flags = new Map<string, string>()
  for (let i = argv[0] === "--" ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (arg !== "--cases" && arg !== "--out" && arg !== "--candidates")
      throw new Error(`unknown argument ${arg}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${arg} requires a value`)
    flags.set(arg, value)
  }
  const candidates = flags.get("--candidates") ?? env["EIDO_EVAL_CANDIDATES"]
  return {
    cases: flags.get("--cases") ?? env["EIDO_EVAL_ASK_CASES"] ?? DEFAULT_CASES,
    out: flags.get("--out") ?? env["EIDO_EVAL_OUT"] ?? ".eval-results",
    ...(candidates === undefined || candidates === "" ? {} : { candidates }),
  }
}

export type AskCandidateResult =
  | {
      name: string
      status: "ran"
      modelId: string
      quantization?: string
      reports: AskEvalReport[]
    }
  | { name: string; status: "failed"; error: string }

async function runCandidate(
  candidate: EvalCandidate,
  cases: AskEvalCase[],
  out: string
): Promise<AskCandidateResult> {
  let server: RunningServer | undefined
  try {
    if (candidate.server !== undefined) {
      server = await startServer({
        baseUrl: candidate.baseUrl,
        command: candidate.server.command,
        logFile: join(out, `${candidate.name}.ask.server.log`),
        ...(candidate.server.readyTimeoutSeconds === undefined
          ? {}
          : { readyTimeoutSeconds: candidate.server.readyTimeoutSeconds }),
      })
    }
    const [modelId, contextTokens] = await Promise.all([
      readModelId(candidate.baseUrl),
      readContextTokens(candidate.baseUrl),
    ])
    const client = await connectModelClient({
      baseUrl: candidate.baseUrl,
      contextTokens,
      maxReplyTokens: MAX_REPLY_TOKENS,
      ...(candidate.chatTemplateKwargs === undefined
        ? {}
        : { chatTemplateKwargs: candidate.chatTemplateKwargs }),
    })
    const reports: AskEvalReport[] = []
    for (const variant of ASK_VARIANTS)
      reports.push(
        await runAskEval({ cases, client, variant, seed: DEFAULT_SEED })
      )
    return {
      name: candidate.name,
      status: "ran",
      modelId,
      ...(candidate.quantization === undefined
        ? {}
        : { quantization: candidate.quantization }),
      reports,
    }
  } catch (error) {
    return {
      name: candidate.name,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await server?.stop()
  }
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

function failing(cases: readonly AskCaseScore[]): string[] {
  return cases
    .filter(
      (c) => !c.tagCitation || !c.placeholderUse || c.noMatchPhrasing === false
    )
    .map((c) => c.id)
}

/** One row per candidate and variant, then the ids of the cases to read. */
export function formatAskTable(results: readonly AskCandidateResult[]): string {
  const lines = [
    "Candidate | Variant | Tag citation | Placeholders | No match found",
  ]
  for (const result of results) {
    if (result.status === "failed") {
      lines.push(`${result.name} | could not run: ${result.error}`)
      continue
    }
    for (const report of result.reports)
      lines.push(
        [
          result.name,
          report.variant,
          percent(report.scores.tagCitation),
          percent(report.scores.placeholderUse),
          percent(report.scores.noMatchPhrasing),
        ].join(" | ")
      )
  }
  for (const result of results) {
    if (result.status !== "ran") continue
    for (const report of result.reports) {
      const ids = failing(report.cases)
      if (ids.length > 0)
        lines.push(
          `${result.name} ${report.variant}: cases to read: ${ids.join(", ")}`
        )
    }
  }
  return `${lines.join("\n")}\n`
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Env = process.env
): Promise<AskCandidateResult[]> {
  const options = parseAskCliOptions(argv, env)
  const candidates =
    options.candidates === undefined
      ? [defaultCandidate(env)]
      : parseCandidates(
          JSON.parse(await readFile(resolve(options.candidates), "utf8")),
          options.candidates
        )
  const cases = loadAskCases(resolve(options.cases))
  const out = resolve(options.out)
  await mkdir(out, { recursive: true })
  const results: AskCandidateResult[] = []
  for (const candidate of candidates)
    results.push(await runCandidate(candidate, cases, out))
  await writeFile(
    join(out, "ask-results.json"),
    `${JSON.stringify({ seed: DEFAULT_SEED, temperature: 0, variants: ASK_VARIANTS satisfies readonly AskVariant[], candidates: results }, null, 2)}\n`
  )
  process.stdout.write(formatAskTable(results))
  if (results.some((r) => r.status === "failed")) process.exitCode = 1
  return results
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
