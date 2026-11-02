import { loopbackBaseUrl } from "../inference/client"
import type { EvalCandidate } from "./types"

// Command-line and environment settings for the eval runner. Cases, verdicts and results are the
// owner's and live outside git: point the runner at them with flags or with the EIDO_EVAL_*
// variables (for example a directory under ~/Library/Application Support/eido-dev/).

export const DEFAULT_SEED = 329

export interface EvalCliOptions {
  cases: string
  verdicts: string
  out: string
  seed: number
  enforce: boolean
  /** A candidates file; without it the runner evaluates the one server at EIDO_LLAMA_HOST/PORT. */
  candidates?: string
}

type Env = Readonly<Record<string, string | undefined>>

const VALUE_FLAGS = new Set([
  "--cases",
  "--verdicts",
  "--out",
  "--seed",
  "--candidates",
])

function set(env: Env, name: string): string | undefined {
  const value = env[name]
  return value === undefined || value === "" ? undefined : value
}

function parseSeed(value: string, source: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${source} must be a non-negative integer`)
  return Number(value)
}

/** Flags win over EIDO_EVAL_* variables, which win over the defaults. */
export function parseCliOptions(
  argv: readonly string[],
  env: Env
): EvalCliOptions {
  const flags = new Map<string, string>()
  let enforce = false
  for (let i = argv[0] === "--" ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (arg === "--enforce") {
      enforce = true
      continue
    }
    if (!VALUE_FLAGS.has(arg)) throw new Error(`unknown eval argument ${arg}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${arg} requires a value`)
    flags.set(arg, value)
  }
  const cases =
    flags.get("--cases") ?? set(env, "EIDO_EVAL_CASES") ?? "eval-local"
  const seedFlag = flags.get("--seed")
  const seedEnv = set(env, "EIDO_EVAL_SEED")
  const candidates =
    flags.get("--candidates") ?? set(env, "EIDO_EVAL_CANDIDATES")
  return {
    cases,
    verdicts:
      flags.get("--verdicts") ??
      set(env, "EIDO_EVAL_VERDICTS") ??
      `${cases}/verdicts.json`,
    out: flags.get("--out") ?? set(env, "EIDO_EVAL_OUT") ?? ".eval-results",
    seed:
      seedFlag !== undefined
        ? parseSeed(seedFlag, "--seed")
        : seedEnv !== undefined
          ? parseSeed(seedEnv, "EIDO_EVAL_SEED")
          : DEFAULT_SEED,
    enforce,
    ...(candidates === undefined ? {} : { candidates }),
  }
}

/** The single candidate when no candidates file is given: the server the data plane would use. */
export function defaultCandidate(env: Env): EvalCandidate {
  const port = set(env, "EIDO_LLAMA_PORT")
  if (port === undefined)
    throw new Error(
      "set EIDO_LLAMA_PORT to the local llama-server port, or pass --candidates <file>"
    )
  const host = set(env, "EIDO_LLAMA_HOST") ?? "127.0.0.1"
  return {
    name: "default",
    baseUrl: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

function only(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, "is not a supported field")
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "")
    return fail(path, "expected a non-empty string")
  return value
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/

function parseCandidate(value: unknown, path: string): EvalCandidate {
  if (!isRecord(value)) return fail(path, "expected an object")
  only(
    value,
    ["name", "baseUrl", "quantization", "chatTemplateKwargs", "server"],
    path
  )
  const name = text(value.name, `${path}.name`)
  if (!NAME.test(name))
    fail(
      `${path}.name`,
      "use lowercase letters, digits, dot, dash or underscore"
    )
  const baseUrl = text(value.baseUrl, `${path}.baseUrl`)
  try {
    loopbackBaseUrl(baseUrl)
  } catch (error) {
    fail(
      `${path}.baseUrl`,
      error instanceof Error ? error.message : String(error)
    )
  }
  const candidate: EvalCandidate = { name, baseUrl }
  if (value.quantization !== undefined)
    candidate.quantization = text(value.quantization, `${path}.quantization`)
  if (value.chatTemplateKwargs !== undefined) {
    if (!isRecord(value.chatTemplateKwargs))
      fail(`${path}.chatTemplateKwargs`, "expected an object")
    candidate.chatTemplateKwargs = value.chatTemplateKwargs
  }
  if (value.server !== undefined) {
    const server = value.server
    const serverPath = `${path}.server`
    if (!isRecord(server)) return fail(serverPath, "expected an object")
    only(server, ["command", "readyTimeoutSeconds"], serverPath)
    if (!Array.isArray(server.command) || server.command.length === 0)
      fail(`${serverPath}.command`, "expected a non-empty array of strings")
    const command = server.command.map((part, i) =>
      text(part, `${serverPath}.command[${String(i)}]`)
    )
    const timeout = server.readyTimeoutSeconds
    if (
      timeout !== undefined &&
      (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
    )
      fail(`${serverPath}.readyTimeoutSeconds`, "expected a positive number")
    candidate.server =
      timeout === undefined
        ? { command }
        : { command, readyTimeoutSeconds: timeout }
  }
  return candidate
}

/** `{ "candidates": [...] }`, validated with the field path of the first error. */
export function parseCandidates(
  value: unknown,
  source: string
): EvalCandidate[] {
  if (!isRecord(value)) return fail(source, "expected an object")
  only(value, ["candidates"], source)
  if (!Array.isArray(value.candidates) || value.candidates.length === 0)
    return fail(`${source}.candidates`, "expected a non-empty array")
  const candidates = value.candidates.map((item, i) =>
    parseCandidate(item, `${source}.candidates[${String(i)}]`)
  )
  const seen = new Set<string>()
  for (const [i, candidate] of candidates.entries()) {
    if (seen.has(candidate.name))
      fail(
        `${source}.candidates[${String(i)}].name`,
        `duplicate name ${candidate.name}`
      )
    seen.add(candidate.name)
  }
  return candidates
}
