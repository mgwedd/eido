import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  connectModelClient,
  loopbackBaseUrl,
  readContextTokens,
  readModelId,
} from "../inference/client"
import { formatComparisonReport } from "./injection-predicates"
import { runInjectionEval } from "./injection-runner"
import { PROMPT_BUILDERS } from "./injection-types"
import type {
  AttackClass,
  InjectionCase,
  PromptBuilderName,
} from "./injection-types"
import { startServer } from "./server"
import type { RunningServer } from "./server"

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.."
)
const DEFAULT_CASES_PATH = join(
  REPO_ROOT,
  "fixtures",
  "injection",
  "cases.json"
)
// The committed report. Only a run on a clean checkout of origin/main writes it, so every row comes from one
// run and feature branches never conflict on it. Other runs write the local copy, which is gitignored.
export const PUBLISHED_REPORT_PATH = join(
  REPO_ROOT,
  "docs",
  "injection-eval.md"
)
export const LOCAL_REPORT_PATH = join(
  REPO_ROOT,
  "eval-local",
  "injection-eval.md"
)
const DEFAULT_MODEL_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "eido-dev",
  "models"
)
const DEFAULT_MODEL_FILE = "gemma-4-26B_q4_0-it.gguf"
const DEFAULT_SERVER_BIN = join(
  homedir(),
  "Library",
  "Application Support",
  "eido-dev",
  "llama.cpp",
  "b11149",
  "llama-server"
)

export interface InjectionCliOptions {
  host: string
  port: number
  baseUrl: string
  cases: string
  out: string | undefined
  builders: PromptBuilderName[]
  noServer: boolean
  modelDir: string
  serverBin: string
  help: boolean
}

type Env = Readonly<Record<string, string | undefined>>

function isPromptBuilderName(value: string): value is PromptBuilderName {
  return (PROMPT_BUILDERS as readonly string[]).includes(value)
}

function isAttackClass(value: unknown): value is AttackClass | "clean" {
  return (
    typeof value === "string" &&
    [
      "fence-tag",
      "template-marker",
      "boundary-confusion",
      "hidden-characters",
      "clean",
    ].includes(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseInjectionCase(raw: unknown, index: number): InjectionCase {
  if (!isRecord(raw)) {
    throw new Error(`case at index ${String(index)} is not an object`)
  }
  const name = typeof raw["name"] === "string" ? raw["name"] : ""
  const text = typeof raw["text"] === "string" ? raw["text"] : ""
  const normalized =
    typeof raw["normalized"] === "string" ? raw["normalized"] : ""
  const attackerGoal =
    typeof raw["attackerGoal"] === "string" ? raw["attackerGoal"] : ""
  const cleanTwin =
    typeof raw["cleanTwin"] === "string" ? raw["cleanTwin"] : text
  const checkPattern =
    typeof raw["checkPattern"] === "string" ? raw["checkPattern"] : ""
  const attackOutput =
    typeof raw["attackOutput"] === "string" ? raw["attackOutput"] : ""
  const cleanOutput =
    typeof raw["cleanOutput"] === "string" ? raw["cleanOutput"] : ""

  if (name === "" || text === "") {
    throw new Error(`case at index ${String(index)} is missing name or text`)
  }

  const reasons = Array.isArray(raw["reasons"])
    ? (raw["reasons"] as InjectionCase["reasons"])
    : []

  const attackClass = isAttackClass(raw["attackClass"])
    ? raw["attackClass"]
    : "clean"

  const question =
    typeof raw["question"] === "string" ? raw["question"] : undefined
  const request =
    typeof raw["request"] === "string" ? raw["request"] : undefined

  return {
    name,
    text,
    normalized,
    reasons,
    attackClass,
    attackerGoal,
    cleanTwin,
    checkPattern,
    attackOutput,
    cleanOutput,
    ...(question === undefined ? {} : { question }),
    ...(request === undefined ? {} : { request }),
  }
}

export function loadInjectionCorpus(filePath: string): InjectionCase[] {
  const content = readFileSync(filePath, "utf8")
  const parsed: unknown = JSON.parse(content)
  if (!isRecord(parsed) || !Array.isArray(parsed["cases"])) {
    throw new Error(`invalid injection corpus at ${filePath}`)
  }
  return parsed["cases"].map((c, i) => parseInjectionCase(c, i))
}

const VALUE_FLAGS = new Set([
  "--host",
  "--port",
  "--cases",
  "--out",
  "--builders",
  "--model-dir",
  "--server-bin",
])

export function parseInjectionCliOptions(
  argv: readonly string[],
  env: Env = process.env
): InjectionCliOptions {
  const flags = new Map<string, string>()
  let noServer = false
  let help = false

  for (let i = argv[0] === "--" ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (arg === "--help" || arg === "-h") {
      help = true
      continue
    }
    if (arg === "--no-server") {
      noServer = true
      continue
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new Error(`unknown argument ${arg}`)
    }
    const val = argv[++i]
    if (val === undefined || val.startsWith("--")) {
      throw new Error(`${arg} requires a value`)
    }
    flags.set(arg, val)
  }

  const host = flags.get("--host") ?? env["EIDO_LLAMA_HOST"] ?? "127.0.0.1"
  const rawPort = flags.get("--port") ?? env["EIDO_LLAMA_PORT"] ?? "8080"
  const port = Number.parseInt(rawPort, 10)
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${rawPort}`)
  }

  const rawCases = flags.get("--cases") ?? env["EIDO_EVAL_CASES"]
  const cases =
    rawCases !== undefined ? resolve(REPO_ROOT, rawCases) : DEFAULT_CASES_PATH
  const rawOut = flags.get("--out") ?? env["EIDO_EVAL_OUT"]
  const out = rawOut !== undefined ? resolve(REPO_ROOT, rawOut) : undefined
  const modelDir =
    flags.get("--model-dir") ?? env["EIDO_MODEL_DIR"] ?? DEFAULT_MODEL_DIR
  const serverBin =
    flags.get("--server-bin") ??
    env["EIDO_LLAMA_SERVER_BIN"] ??
    DEFAULT_SERVER_BIN

  const rawBuilders = flags.get("--builders")
  let builders: PromptBuilderName[] = [...PROMPT_BUILDERS]
  if (rawBuilders !== undefined) {
    builders = rawBuilders
      .split(",")
      .map((s) => s.trim())
      .filter(isPromptBuilderName)
    if (builders.length === 0) {
      throw new Error(`no valid prompt builders in --builders ${rawBuilders}`)
    }
  }

  const baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${String(port)}`

  return {
    host,
    port,
    baseUrl,
    cases,
    out,
    builders,
    noServer,
    modelDir,
    serverBin,
    help,
  }
}

export interface GitState {
  head: string | null
  originMain: string | null
  dirty: boolean
}

export function readGitState(cwd: string = REPO_ROOT): GitState {
  const git = (args: string[]): string | null => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" })
    return r.status === 0 ? r.stdout.trim() : null
  }
  const status = git(["status", "--porcelain"])
  return {
    head: git(["rev-parse", "HEAD"]),
    originMain: git(["rev-parse", "--verify", "-q", "origin/main"]),
    dirty: status === null || status !== "",
  }
}

export function onCleanMain(state: GitState): boolean {
  return state.head !== null && state.head === state.originMain && !state.dirty
}

/** Where the report goes: the committed path only from a clean origin/main checkout. */
export function resolveReportPath(
  out: string | undefined,
  state: GitState
): string {
  const published = resolve(PUBLISHED_REPORT_PATH)
  if (out !== undefined && resolve(out) !== published) return out
  if (onCleanMain(state)) return published
  if (out === undefined) return LOCAL_REPORT_PATH
  throw new Error(
    "docs/injection-eval.md is written only from a clean checkout of origin/main. " +
      "Run without --out to write eval-local/injection-eval.md, and put your numbers in the PR body."
  )
}

async function isServerHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${loopbackBaseUrl(baseUrl)}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    await res.body?.cancel()
    return res.status === 200
  } catch {
    return false
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Env = process.env,
  gitState: () => GitState = readGitState
): Promise<void> {
  const options = parseInjectionCliOptions(argv, env)

  if (options.help) {
    console.log(
      "Usage: pnpm --filter @eido/core eval-injection [options]\n\n" +
        "Options:\n" +
        "  --host <host>          Host (default: 127.0.0.1)\n" +
        "  --port <port>          Port (default: 8080)\n" +
        "  --cases <file>         Cases JSON path (default: fixtures/injection/cases.json)\n" +
        "  --out <file>           Output markdown report path (default: docs/injection-eval.md on a clean\n" +
        "                         origin/main checkout, else eval-local/injection-eval.md)\n" +
        "  --builders <list>      Comma-separated builders: ask,propose,digest,extraction\n" +
        "  --model-dir <dir>      Model directory for llama-server auto-start\n" +
        "  --server-bin <bin>     llama-server binary path for auto-start\n" +
        "  --no-server            Do not auto-start llama-server if not running\n" +
        "  --help, -h             Show help\n"
    )
    return
  }

  const outPath = resolveReportPath(options.out, gitState())
  const cases = loadInjectionCorpus(options.cases)
  console.log(
    `Loaded ${String(cases.length)} injection cases from ${options.cases}`
  )

  let runningServer: RunningServer | undefined
  const healthy = await isServerHealthy(options.baseUrl)

  if (!healthy) {
    if (options.noServer) {
      throw new Error(
        `no server is running at ${options.baseUrl} and --no-server was specified`
      )
    }

    const modelPath = join(options.modelDir, DEFAULT_MODEL_FILE)
    if (!existsSync(options.serverBin)) {
      throw new Error(
        `llama-server not found at ${options.serverBin}. Run it manually or check infra pin.`
      )
    }
    if (!existsSync(modelPath)) {
      throw new Error(
        `model not found at ${modelPath}. Download model or check infra pin.`
      )
    }

    console.log(`Starting llama-server on port ${String(options.port)}...`)
    const logFile = join(REPO_ROOT, ".eval-server.log")
    runningServer = await startServer({
      baseUrl: options.baseUrl,
      command: [
        options.serverBin,
        "-m",
        modelPath,
        "--jinja",
        "--host",
        options.host,
        "--port",
        String(options.port),
        "-c",
        "8192",
        "-fa",
        "on",
        "--cache-type-k",
        "q8_0",
        "--cache-type-v",
        "q8_0",
        "-ngl",
        "99",
        "-b",
        "2048",
        "-ub",
        "2048",
        "-t",
        "8",
        "--reasoning",
        "off",
      ],
      logFile,
      readyTimeoutSeconds: 300,
    })
    console.log("llama-server is ready.")
  }

  try {
    const [modelId, contextTokens] = await Promise.all([
      readModelId(options.baseUrl),
      readContextTokens(options.baseUrl),
    ])

    console.log(
      `Connected to model ${modelId} (context: ${String(contextTokens)} tokens)`
    )
    const client = await connectModelClient({
      baseUrl: options.baseUrl,
      contextTokens,
      maxReplyTokens: 256,
      charsPerToken: 3.5,
    })

    console.log(
      `Running eval across ${String(options.builders.length)} builders (${options.builders.join(", ")})...`
    )

    let lastProgressPct = -1
    const displayModelId = basename(modelId)
    const report = await runInjectionEval(cases, client, {
      builders: options.builders,
      modelId: displayModelId,
      quantization: "Q4_0 (QAT)",
      onProgress: (p) => {
        const pct = Math.floor((p.completed / p.total) * 100)
        if (pct !== lastProgressPct && pct % 10 === 0) {
          lastProgressPct = pct
          console.log(
            `Progress: ${String(pct)}% (${p.caseName} [${p.builder}] ${p.phase})`
          )
        }
      },
    })

    const markdown = formatComparisonReport(report)
    console.log("\n" + markdown)

    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, markdown, "utf8")
    console.log(`\nWrote evaluation results to ${outPath}`)

    if (report.failingFencedCases.length > 0) {
      console.warn(
        `\nWARNING: ${String(report.failingFencedCases.length)} fenced cases succeeded! File an issue for each failing builder.`
      )
    }
  } finally {
    if (runningServer !== undefined) {
      console.log("Stopping llama-server...")
      await runningServer.stop()
      console.log("llama-server stopped.")
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
