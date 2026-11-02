// `pnpm stack:dev|stack:prod|stack:stop|stack:status [--no-serve] [--background]` (#374)
//   dev     gate and core under `node --watch`, web under `next dev`; output prefixed by name
//   prod    `turbo run build`, then gate, core and `next start`, with no watchers
//   stop    stops what either mode started, foreground or background, from the pid files
//   status  each process, its port, who listens on it, and whether it answers its health check
// Start checks the ports are free, applies the serve routes on :8443 (part of start: the UI calls
// /api/gate and /api/core on its own origin), then starts gate, core and web in that order, each
// once the one before answers. `--no-serve` leaves the routes out: backends only, no working UI.
// `--background` returns once all three answer and leaves them running; stop them with stop.
import { join } from "node:path"

import { main as serveRoutes } from "../tailscale/cli.ts"
import type { Fetch } from "../tailscale/measure.ts"
import { parseDnsName } from "../tailscale/serve-routes.ts"
import {
  buildStackConfig,
  type Env,
  type Mode,
  type ProcessName,
  type ProcessSpec,
  type StackConfig,
} from "./config.ts"
import {
  busyPorts,
  describeListeners,
  listenersOn,
  type Exec,
} from "./ports.ts"
import {
  answers,
  parsePidRecord,
  startInOrder,
  stopRecord,
  waitReady,
  type Clock,
  type Launched,
  type PidRecord,
  type Probe,
  type Signal,
  type Started,
} from "./supervise.ts"

export type LaunchOptions = {
  logFile: string
  /** Detached with output to the log only; the stack outlives this command. */
  background: boolean
  /** Also print each output line to the terminal, prefixed by the process name. */
  prefixOutput: boolean
}

export type Files = {
  exists: (path: string) => boolean
  read: (path: string) => string | undefined
  write: (path: string, text: string) => void
  remove: (path: string) => void
  /** mkdir -p, then chmod 700. */
  ensurePrivateDir: (path: string) => void
}

export type Deps = {
  env: Env
  home: string
  repoRoot: string
  nodePath: string
  exec: Exec
  /** `pnpm turbo run build` from the repo root with output to the terminal; its exit code. */
  build: () => Promise<number>
  launch: (spec: ProcessSpec, options: LaunchOptions) => Launched
  fetch: Fetch
  clock: Clock
  signalGroup: (pid: number, signal: Signal) => void
  groupAlive: (pid: number) => boolean
  files: Files
  /** Calls `handler` once on SIGINT, SIGTERM or SIGHUP. */
  onStopSignal: (handler: () => void) => void
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = "usage: stack dev|prod|stop|status [--no-serve] [--background]"

const PORT_VARIABLES: Record<ProcessName, string> = {
  gate: "EIDO_GATE_PHONE_PORT",
  core: "EIDO_CORE_PORT",
  web: "EIDO_WEB_PORT",
}

type Flags = { serve: boolean; background: boolean }

export function parseArgs(
  argv: readonly string[]
): { command: "dev" | "prod" | "stop" | "status"; flags: Flags } | undefined {
  const [command, ...rest] = argv
  if (
    command !== "dev" &&
    command !== "prod" &&
    command !== "stop" &&
    command !== "status"
  )
    return undefined
  const flags: Flags = { serve: true, background: false }
  for (const arg of rest) {
    if (arg === "--no-serve") flags.serve = false
    else if (
      arg === "--background" &&
      (command === "dev" || command === "prod")
    )
      flags.background = true
    else return undefined
  }
  return { command, flags }
}

const pidFile = (config: StackConfig, name: ProcessName) =>
  join(config.runDir, `${name}.pid`)
const logFile = (config: StackConfig, name: ProcessName) =>
  join(config.logDir, `${name}.log`)

function probeWith(fetch: Fetch): Probe {
  return async (url) => {
    try {
      return (await fetch(url)).status
    } catch {
      return undefined
    }
  }
}

async function argsOf(exec: Exec, pid: number): Promise<string | undefined> {
  const run = await exec("ps", ["-o", "args=", "-p", String(pid)])
  return run.code === 0 && run.stdout.trim() !== ""
    ? run.stdout.trim()
    : undefined
}

async function tailscaleHost(deps: Deps): Promise<string> {
  const run = await deps.exec("tailscale", ["status", "--json"])
  if (run.code !== 0)
    throw new Error(
      `tailscale status --json failed: ${run.stderr.trim() || `exit ${run.code}`}. Is Tailscale running? Use --no-serve for backends only.`
    )
  return parseDnsName(run.stdout)
}

/** The tailnet host: EIDO_TAILNET_HOST, else Self.DNSName from tailscale when serving, else localhost. */
async function resolveHost(deps: Deps, serve: boolean): Promise<string> {
  const fromEnv = deps.env["EIDO_TAILNET_HOST"]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  return serve ? await tailscaleHost(deps) : "localhost"
}

function configFor(deps: Deps, mode: Mode, tailnetHost: string): StackConfig {
  return buildStackConfig({
    mode,
    env: deps.env,
    home: deps.home,
    repoRoot: deps.repoRoot,
    nodePath: deps.nodePath,
    tailnetHost,
  })
}

function serveDeps(deps: Deps) {
  return {
    tailscale: (args: readonly string[]) => deps.exec("tailscale", args),
    fetch: deps.fetch,
    out: (line: string) => deps.out(`serve | ${line}`),
    err: (line: string) => deps.err(`serve | ${line}`),
  }
}

function readRecord(
  deps: Deps,
  config: StackConfig,
  name: ProcessName
): PidRecord | undefined {
  const text = deps.files.read(pidFile(config, name))
  return text === undefined ? undefined : parsePidRecord(text)
}

/** Stops the named processes in reverse start order and removes their pid files. */
async function stopAll(
  deps: Deps,
  config: StackConfig,
  names: readonly ProcessName[]
) {
  const stopDeps = {
    argsOf: (pid: number) => argsOf(deps.exec, pid),
    signalGroup: deps.signalGroup,
    groupAlive: deps.groupAlive,
    clock: deps.clock,
  }
  for (const name of [...names].reverse()) {
    const path = pidFile(config, name)
    if (!deps.files.exists(path)) continue
    const record = readRecord(deps, config, name)
    if (record === undefined) {
      deps.out(`${name}: unreadable pid file removed`)
    } else {
      const outcome = await stopRecord(record, stopDeps)
      const notes: Record<typeof outcome, string> = {
        stopped: "stopped",
        killed: "did not stop on SIGTERM; killed",
        "not running": "was not running",
        "not ours": "pid now belongs to another program; left alone",
      }
      deps.out(`${name}: ${notes[outcome]} (pid ${record.pid})`)
    }
    deps.files.remove(path)
  }
}

async function start(deps: Deps, mode: Mode, flags: Flags): Promise<number> {
  const config = configFor(deps, mode, await resolveHost(deps, flags.serve))

  const busy = await busyPorts(
    deps.exec,
    config.processes.map((spec) => ({
      name: spec.name,
      port: spec.port,
      variable: PORT_VARIABLES[spec.name],
    }))
  )
  if (busy.length > 0) {
    for (const message of busy) deps.err(`FAIL: ${message}`)
    deps.err("Nothing was started.")
    return 1
  }

  if (flags.serve) {
    const code = await serveRoutes(
      ["apply", ...config.serveFlags],
      serveDeps(deps)
    )
    if (code !== 0) {
      deps.err(
        "Nothing was started: the serve routes are not in place. Use --no-serve for backends only."
      )
      return 1
    }
  }

  if (mode === "prod") {
    deps.out("$ pnpm turbo run build")
    const code = await deps.build()
    if (code !== 0) {
      deps.err(`FAIL: the build exited with code ${code}; nothing was started.`)
      return 1
    }
  }

  for (const dir of config.privateDirs) deps.files.ensurePrivateDir(dir)

  const probe = probeWith(deps.fetch)
  const { started, failure } = await startInOrder(config.processes, {
    launch: (spec) => {
      const launched = deps.launch(spec, {
        logFile: logFile(config, spec.name),
        background: flags.background,
        prefixOutput: mode === "dev" && !flags.background,
      })
      const record: PidRecord = {
        name: spec.name,
        pid: launched.pid,
        marker: spec.marker,
        mode,
      }
      deps.files.write(
        pidFile(config, spec.name),
        `${JSON.stringify(record)}\n`
      )
      deps.out(
        `${spec.name}: started pid ${launched.pid}, log ${logFile(config, spec.name)}`
      )
      return launched
    },
    ready: (spec, launched) =>
      waitReady(spec, launched, {
        probe,
        clock: deps.clock,
        // Core reaches the gate only through its data-plane socket.
        ...(spec.name === "gate"
          ? { alsoReady: () => deps.files.exists(config.gateSocket) }
          : {}),
      }).then((result) => {
        if (result === undefined)
          deps.out(`${spec.name}: answers on ${spec.healthUrl}`)
        return result
      }),
  })
  const names = started.map((s) => s.spec.name)
  if (failure !== undefined) {
    const last = started.at(-1)?.spec.name ?? "gate"
    deps.err(`FAIL: ${failure}; see ${logFile(config, last)}`)
    await stopAll(deps, config, names)
    return 1
  }

  if (flags.serve) deps.out(`Open ${config.url}`)
  else
    deps.out(
      "Backends only (--no-serve): no serve routes, so the UI does not work from the tailnet origin."
    )

  if (flags.background) {
    deps.out("Running in the background. Stop with: pnpm stack:stop")
    return 0
  }
  deps.out("Press Ctrl-C to stop all three.")
  return await supervise(deps, config, started)
}

/** Foreground: waits for a stop signal or for any process to exit, then stops all of them. */
async function supervise(
  deps: Deps,
  config: StackConfig,
  started: Started[]
): Promise<number> {
  const reason = await new Promise<
    { signal: true } | { name: ProcessName; code: number | null }
  >((resolve) => {
    deps.onStopSignal(() => resolve({ signal: true }))
    for (const { spec, launched } of started)
      void launched.exited.then((code) => resolve({ name: spec.name, code }))
  })
  if ("name" in reason)
    deps.err(
      `${reason.name} exited with code ${String(reason.code)}; stopping the rest`
    )
  else deps.out("Stopping...")
  await stopAll(
    deps,
    config,
    started.map((s) => s.spec.name)
  )
  return "name" in reason ? 1 : 0
}

async function stop(deps: Deps): Promise<number> {
  const config = configFor(deps, "dev", "localhost")
  const names = config.processes.map((spec) => spec.name)
  if (!names.some((name) => deps.files.exists(pidFile(config, name))))
    deps.out("No stack pid files; nothing to stop.")
  await stopAll(deps, config, names)
  let left = 0
  for (const spec of config.processes) {
    const listeners = await listenersOn(deps.exec, spec.port)
    if (listeners.length === 0) continue
    left++
    deps.out(
      `port ${spec.port} (${spec.name}) still has a listener the stack did not start: ${describeListeners(listeners)}; left alone`
    )
  }
  if (left === 0) deps.out("Nothing listens on the stack's ports.")
  return 0
}

async function status(deps: Deps, flags: Flags): Promise<number> {
  const config = configFor(deps, "dev", await resolveHost(deps, flags.serve))
  const probe = probeWith(deps.fetch)
  let healthy = 0
  for (const spec of config.processes) {
    const record = readRecord(deps, config, spec.name)
    const running =
      record !== undefined &&
      (await argsOf(deps.exec, record.pid))?.includes(record.marker) === true
    const state =
      record === undefined
        ? "not started by the stack"
        : running
          ? `running (pid ${record.pid}, ${record.mode})`
          : `stale pid file (pid ${record.pid} is gone)`
    const listeners = await listenersOn(deps.exec, spec.port)
    const listening =
      listeners.length === 0
        ? "nothing listening"
        : `listener ${describeListeners(listeners)}`
    const code = await probe(spec.healthUrl)
    if (answers(code)) healthy++
    const health =
      code === undefined
        ? "no answer"
        : answers(code)
          ? `answers ${code}`
          : `fails ${code}`
    deps.out(
      `${spec.name}: ${state}; 127.0.0.1:${spec.port} ${listening}; health ${health}`
    )
  }
  let serveCode = 0
  if (flags.serve) {
    serveCode = await serveRoutes(
      ["check", ...config.serveFlags],
      serveDeps(deps)
    )
    deps.out(`url: ${config.url}`)
  }
  return healthy === config.processes.length && serveCode === 0 ? 0 : 1
}

export async function main(
  argv: readonly string[],
  deps: Deps
): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed === undefined) {
    deps.err(USAGE)
    return 2
  }
  try {
    switch (parsed.command) {
      case "dev":
      case "prod":
        return await start(deps, parsed.command, parsed.flags)
      case "stop":
        return await stop(deps)
      case "status":
        return await status(deps, parsed.flags)
    }
  } catch (error) {
    deps.err(`FAIL: ${(error as Error).message}`)
    return 1
  }
}
