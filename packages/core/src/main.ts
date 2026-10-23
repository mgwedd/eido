import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { createAuditClient, createIntentClient } from "@eido/gate"
import type { IntentClient } from "@eido/gate"
import { basePath, listenCoreApi, loopbackHost } from "./api/listen"
import type { CoreApi, LoopbackHost } from "./api/listen"
import { openIndex } from "./index/schema"
import { openDataDb } from "./ledger/db"
import { LedgerError } from "./ledger/errors"
import { createProfileStore, readDefaultEntityId } from "./profile/store"
import type { ProfileStore } from "./profile/store"

// The data-plane process (ADR 0003). It owns eido-data.db, serves core's API on loopback, and
// reaches the gate only through the intent and audit clients on the gate's data-plane socket.
// Its environment is built from an allowlist, so no token, Keychain or OAuth variable and no
// path to the gate's control DB or control socket can be inherited: started with anything else
// in its environment, it re-runs itself with only the allowlisted variables. Start it with `pnpm --filter @eido/core start`.

/**
 * The only variables the data plane may see: data dir, gate socket, llama-server address, and
 * where core's API listens (loopback host, port, base path, extra Host headers to answer).
 */
export const DATA_PLANE_ENV = [
  "EIDO_DATA_DIR",
  "EIDO_GATE_SOCKET",
  "EIDO_LLAMA_HOST",
  "EIDO_LLAMA_PORT",
  "EIDO_CORE_HOST",
  "EIDO_CORE_PORT",
  "EIDO_CORE_BASE_PATH",
  "EIDO_CORE_ALLOWED_HOSTS",
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

/** Where core's API listens unless EIDO_CORE_HOST and EIDO_CORE_PORT say otherwise. */
export const DEFAULT_CORE_HOST = "127.0.0.1"
export const DEFAULT_CORE_PORT = 8787

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

export type CoreApiConfig = {
  host: LoopbackHost
  port: number
  /** Empty, or the prefix routes are served under (`/api/core` when serve forwards it). */
  basePath: string
  /** Host headers answered besides the listen address, such as the one serve forwards. */
  allowedHosts: string[]
}

export type DataPlaneConfig = {
  dataDir: string
  dbPath: string
  logPath: string
  gateSocket: string
  api: CoreApiConfig
}

function portOf(value: string): number {
  const port = Number(value)
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new Error(
      `EIDO_CORE_PORT must be a port number, not ${JSON.stringify(value)}`
    )
  }
  return port
}

/** Core's API settings. A bind address other than 127.0.0.1 or ::1 throws: core has no auth. */
export function coreApiConfig(env: Env): CoreApiConfig {
  return {
    host: loopbackHost(env["EIDO_CORE_HOST"] || DEFAULT_CORE_HOST),
    port: portOf(env["EIDO_CORE_PORT"] || String(DEFAULT_CORE_PORT)),
    basePath: basePath(env["EIDO_CORE_BASE_PATH"] ?? ""),
    allowedHosts: (env["EIDO_CORE_ALLOWED_HOSTS"] ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host !== ""),
  }
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
    api: coreApiConfig(env),
  }
}

export type DataPlane = {
  db: DatabaseSync
  gate: IntentClient
  /** The owner profile and entities; each entity or assignment change is audited by the gate. */
  profile: ProfileStore
  log: (event: string, fields?: Readonly<Record<string, string>>) => void
  /** Waits for the profile store's queued calls to settle, then closes eido-data.db. */
  close: () => Promise<void>
}

/**
 * Opens eido-data.db with the ledger schema (`openDataDb`), passing the default entity stored in
 * the file so documents stored before the ledger get it. When such documents exist and no default
 * entity is set, the ledger cannot be applied yet: the file is opened at the index schema alone and
 * `ledger_pending` is logged, so the profile API still serves and the next start applies the
 * ledger once a default entity is set.
 */
export function openDataPlaneDb(
  path: string,
  log: DataPlane["log"]
): DatabaseSync {
  const index = openIndex(path)
  let defaultEntityId: string | null
  try {
    defaultEntityId = readDefaultEntityId(index)
  } finally {
    index.close()
  }
  try {
    return openDataDb(path, defaultEntityId === null ? {} : { defaultEntityId })
  } catch (error) {
    if (
      !(error instanceof LedgerError) ||
      error.code !== "default_entity_required"
    )
      throw error
    log("ledger_pending", { reason: error.code })
    return openIndex(path)
  }
}

/**
 * Opens eido-data.db, the gate clients and the profile store, whose audit sink is the gate's
 * POST /audit, and logs the configuration and variable names.
 */
export function runDataPlane(config: DataPlaneConfig, env: Env): DataPlane {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const log: DataPlane["log"] = (event, fields = {}) => {
    appendFileSync(
      config.logPath,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
      { mode: 0o600 }
    )
  }
  const db = openDataPlaneDb(config.dbPath, log)
  const gate = createIntentClient({ socketPath: config.gateSocket })
  const audit = createAuditClient({ socketPath: config.gateSocket })
  const profile = createProfileStore(db, { audit: audit.record })
  log("started", {
    dataDir: config.dataDir,
    db: config.dbPath,
    gateSocket: config.gateSocket,
    env: Object.keys(env).sort().join(","),
  })
  return {
    db,
    gate,
    profile,
    log,
    close: async () => {
      await profile.drain()
      db.close()
      log("stopped")
    },
  }
}

/** Starts core's API for `plane` and logs where it listens. */
export async function serveDataPlane(
  plane: DataPlane,
  config: CoreApiConfig
): Promise<CoreApi> {
  const api = await listenCoreApi({ profile: plane.profile, ...config })
  plane.log("listening", {
    host: api.host,
    port: String(api.port),
    basePath: config.basePath,
    allowedHosts: api.allowedHosts.join(","),
  })
  return api
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

/**
 * The listening API keeps the process up. On the first stop signal it stops taking requests,
 * then closes the data plane once its queued store calls settle, even when closing the API fails;
 * resolves once both are closed.
 */
export function holdUntilStopped(
  plane: DataPlane,
  api: CoreApi,
  signals: SignalSource
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopped = false
    for (const signal of SIGNALS) {
      signals.once(signal, () => {
        if (stopped) return
        stopped = true
        const stop = async (): Promise<void> => {
          try {
            await api.close()
          } finally {
            await plane.close()
          }
        }
        stop().then(resolve, reject)
      })
    }
  })
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
    const config = dataPlaneConfig(process.env)
    const plane = runDataPlane(config, process.env)
    await holdUntilStopped(
      plane,
      await serveDataPlane(plane, config.api),
      process
    )
  }
}
