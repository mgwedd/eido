import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { createIntentClient } from "@eido/gate"
import type { IntentClient } from "@eido/gate"
import { openIndex } from "./index/schema"

// The data-plane process (ADR 0003). It owns eido-data.db and reaches the gate only through
// the intent client on the gate's data-plane socket. Its environment is built from an
// allowlist, so no token, Keychain or OAuth variable and no path to the gate's control DB or
// control socket can be inherited: started with anything else in its environment, it re-runs
// itself with only the allowlisted variables. Start it with `pnpm --filter @eido/core start`.

/** The only variables the data plane may see: data dir, gate socket, llama-server address. */
export const DATA_PLANE_ENV = [
  "EIDO_DATA_DIR",
  "EIDO_GATE_SOCKET",
  "EIDO_LLAMA_HOST",
  "EIDO_LLAMA_PORT",
] as const

/**
 * Names the OS adds to every new process whatever environment it is given (macOS sets the text
 * encoding). They carry no credential; the allowlist check ignores them, or the re-exec would
 * never settle.
 */
export const OS_ADDED_ENV = ["__CF_USER_TEXT_ENCODING"] as const

/** Passed to the re-run process, which then never re-runs again. */
export const SCRUBBED_FLAG = "--env-scrubbed"

export const DATA_DB_FILE = "eido-data.db"
export const DATA_PLANE_LOG_FILE = "data-plane.log"

type Env = Readonly<Record<string, string | undefined>>

/** The allowlisted, non-empty variables of `env`. */
export function dataPlaneEnv(env: Env): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const name of DATA_PLANE_ENV) {
    const value = env[name]
    if (value !== undefined && value !== "") picked[name] = value
  }
  return picked
}

/** Names in `env` outside the allowlist, sorted. Names only: values are never read. */
export function outsideAllowlist(env: Env): string[] {
  const allowed: readonly string[] = [...DATA_PLANE_ENV, ...OS_ADDED_ENV]
  return Object.keys(env)
    .filter((name) => !allowed.includes(name))
    .sort()
}

export type DataPlaneConfig = {
  dataDir: string
  dbPath: string
  logPath: string
  gateSocket: string
}

export function dataPlaneConfig(env: Env): DataPlaneConfig {
  const dataDir = env["EIDO_DATA_DIR"] ?? ""
  const gateSocket = env["EIDO_GATE_SOCKET"] ?? ""
  const missing = [
    ...(dataDir === "" ? ["EIDO_DATA_DIR"] : []),
    ...(gateSocket === "" ? ["EIDO_GATE_SOCKET"] : []),
  ]
  if (missing.length > 0) {
    throw new Error(`the data plane needs ${missing.join(", ")}`)
  }
  return {
    dataDir,
    dbPath: join(dataDir, DATA_DB_FILE),
    logPath: join(dataDir, DATA_PLANE_LOG_FILE),
    gateSocket,
  }
}

export type DataPlane = {
  db: DatabaseSync
  gate: IntentClient
  log: (event: string, fields?: Readonly<Record<string, string>>) => void
  close: () => void
}

/** Opens eido-data.db and the gate client, and logs the configuration and variable names. */
export function runDataPlane(config: DataPlaneConfig, env: Env): DataPlane {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const log: DataPlane["log"] = (event, fields = {}) => {
    appendFileSync(
      config.logPath,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
      { mode: 0o600 }
    )
  }
  const db = openIndex(config.dbPath)
  const gate = createIntentClient({ socketPath: config.gateSocket })
  log("started", {
    dataDir: config.dataDir,
    db: config.dbPath,
    gateSocket: config.gateSocket,
    env: Object.keys(env).sort().join(","),
  })
  return {
    db,
    gate,
    log,
    close: () => {
      db.close()
      log("stopped")
    },
  }
}

const SIGNALS = ["SIGTERM", "SIGINT"] as const
type Signal = (typeof SIGNALS)[number]

export type Launch =
  | { kind: "reexec"; args: string[]; env: Record<string, string> }
  | { kind: "run" }

/**
 * Re-run with only the allowlisted variables when the environment holds anything else, once:
 * the re-run process carries SCRUBBED_FLAG and never re-runs again.
 */
export function launchPlan(
  argv: readonly string[],
  execArgv: readonly string[],
  env: Env
): Launch {
  if (argv.includes(SCRUBBED_FLAG) || outsideAllowlist(env).length === 0) {
    return { kind: "run" }
  }
  return {
    kind: "reexec",
    args: [...execArgv, ...argv.slice(1), SCRUBBED_FLAG],
    env: dataPlaneEnv(env),
  }
}

type SignalSource = { once: (signal: Signal, listener: () => void) => unknown }

/** Keeps the process up until the first stop signal, then closes the data plane. */
export function holdUntilStopped(
  plane: DataPlane,
  signals: SignalSource
): void {
  // Nothing is served yet (the data-plane API server is #153); the process stays up holding
  // eido-data.db until it is stopped.
  const alive = setInterval(() => undefined, 1 << 30)
  let stopped = false
  for (const signal of SIGNALS) {
    signals.once(signal, () => {
      if (stopped) return
      stopped = true
      clearInterval(alive)
      plane.close()
    })
  }
}

type Child = {
  kill: (signal: Signal) => unknown
  once: (event: "exit", listener: (code: number | null) => void) => unknown
}
type Parent = {
  on: (signal: Signal, listener: () => void) => unknown
  exit: (code: number) => void
}

/** Passes stop signals on to the re-run process and exits with its exit code. */
export function forwardTo(child: Child, parent: Parent): void {
  for (const signal of SIGNALS) parent.on(signal, () => child.kill(signal))
  child.once("exit", (code) => parent.exit(code ?? 1))
}

if (import.meta.main) {
  const plan = launchPlan(process.argv, process.execArgv, process.env)
  if (plan.kind === "reexec") {
    const child = spawn(process.execPath, plan.args, {
      env: plan.env,
      stdio: "inherit",
    })
    forwardTo(child, process)
  } else {
    holdUntilStopped(
      runDataPlane(dataPlaneConfig(process.env), process.env),
      process
    )
  }
}
