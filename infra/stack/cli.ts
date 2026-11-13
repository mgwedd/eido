// `pnpm stack:dev|stack:prod|stack:stop|stack:status [--no-serve] [--background]` (#374)
// `pnpm stack:doctor [--no-serve]`, `pnpm stack:setup`, `pnpm stack:gate <cli> [args]` (#625)
//   dev     gate and core under `node --watch`, web under `next dev`; output prefixed by name
//   prod    `turbo run build`, then gate, core and `next start`, with no watchers
//   stop    stops what either mode started, foreground or background, from the pid files
//   status  each process, its port, who listens on it, and whether it answers its health check
// Start checks the ports are free, applies the serve routes on :8443 (part of start: the UI calls
// /api/gate and /api/core on its own origin), then starts gate, core and web in that order, each
// once the one before answers. `--no-serve` leaves the routes out: backends only, no working UI.
// `--background` returns once all three answer and leaves them running; stop them with stop.
//   doctor  read-only checks, each ok, warn or fail with the command that fixes it; exit 1 on a fail
//   setup   creates the gate keychain if missing, asks for unset settings, writes stack.env, runs doctor
//   gate    runs the gate's connect, enrol-code or passkeys script with the stack's gate environment
// `pnpm stack:install`, `pnpm stack:uninstall` (#629, macOS)
//   install    writes and loads the login agent com.eido.stack (agent.ts), which runs the
//              supervisor at login and keeps it running; the supervisor starts the prod stack
//   uninstall  boots the agent out and removes its plist; the stack's processes keep running
//   boot       what the agent runs first: `prod --background`, unless a stack process already runs
// `pnpm stack:bootstrap` (#648): the whole first run as one command, safe to rerun. It installs the
//   dependencies, installs the pinned llama-server build (no model: that is the Admin page's job),
//   runs setup, starts the prod stack, registers the login agent (macOS) and ends by printing the
//   first enrolment code with the first-run page's address. Once a passkey exists it issues no code.
// Every command first loads stack.env (settings.ts); a variable set in the environment wins.
// Start runs doctor's blocking checks before anything else and stops on a failure.
import {
  agentBootoutArgs,
  agentBootstrapArgs,
  agentEnv,
  agentLayout,
  agentPrintArgs,
  agentState,
  agentStatusLine,
  agentTarget,
  buildAgentPlist,
  type AgentState,
} from "./agent.ts"
import { main as serveRoutes } from "../tailscale/cli.ts"
import type { Fetch } from "../tailscale/measure.ts"
import { parseDnsName } from "../tailscale/serve-routes.ts"
import {
  buildStackConfig,
  logFilePath,
  pathsFor,
  pidFilePath,
  type Env,
  type Mode,
  type Platform,
  type ProcessName,
  type ProcessSpec,
  type StackConfig,
} from "./config.ts"
import { failed, formatCheck, runDoctor, type DoctorDeps } from "./doctor.ts"
import {
  busyPorts,
  describeListeners,
  listenersOn,
  type Exec,
} from "./ports.ts"
import {
  processControl,
  tailscaleBin,
  type ProcessControl,
} from "./process-control.ts"
import {
  applyStackSettings,
  readStackSettings,
  stackSettingsPath,
  type FileStat,
  type StackSettings,
} from "./settings.ts"
import { runSetup, type SetupDeps } from "./setup.ts"
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
  /** lstat: undefined when nothing is at the path. */
  stat: (path: string) => FileStat | undefined
  setMode: (path: string, mode: number) => void
}

export type Deps = {
  platform: Platform
  env: Env
  home: string
  repoRoot: string
  nodePath: string
  /** The user id launchd's gui domain is named by; undefined where there is none (Windows). */
  uid: number | undefined
  exec: Exec
  /** `pnpm turbo run build` from the repo root with output to the terminal; its exit code. */
  build: () => Promise<number>
  launch: (spec: ProcessSpec, options: LaunchOptions) => Launched
  fetch: Fetch
  clock: Clock
  control?: ProcessControl
  signalGroup: (pid: number, signal: Signal) => void
  groupAlive: (pid: number) => boolean
  files: Files
  /** Calls `handler` once on SIGINT, SIGTERM or SIGHUP. */
  onStopSignal: (handler: () => void) => void
  /** `process.version`. */
  nodeVersion: string
  /** SHA-256 of a file, lowercase hex. */
  sha256: (path: string) => Promise<string>
  interactive: SetupDeps["interactive"]
  ask: SetupDeps["ask"]
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE =
  "usage: stack dev|prod|stop|status|doctor [--no-serve] [--background] | setup | bootstrap | install | uninstall | boot | gate connect|enrol-code|passkeys [args]"

export const GATE_SCRIPTS = ["connect", "enrol-code", "passkeys"] as const
type GateScript = (typeof GATE_SCRIPTS)[number]
const isGateScript = (value: string | undefined): value is GateScript =>
  GATE_SCRIPTS.some((script) => script === value)

const PORT_VARIABLES: Record<ProcessName, string> = {
  gate: "EIDO_GATE_PHONE_PORT",
  core: "EIDO_CORE_PORT",
  web: "EIDO_WEB_PORT",
}

type Flags = { serve: boolean; background: boolean }

export type Parsed =
  | {
      command:
        | "dev"
        | "prod"
        | "stop"
        | "status"
        | "doctor"
        | "setup"
        | "bootstrap"
        | "install"
        | "uninstall"
        | "boot"
      flags: Flags
    }
  | { command: "gate"; script: GateScript; args: string[] }

export function parseArgs(argv: readonly string[]): Parsed | undefined {
  const [command, ...rest] = argv
  if (command === "gate") {
    const [script, ...args] = rest
    return isGateScript(script) ? { command, script, args } : undefined
  }
  if (
    command === "setup" ||
    command === "bootstrap" ||
    command === "install" ||
    command === "uninstall" ||
    command === "boot"
  )
    return rest.length === 0
      ? { command, flags: { serve: true, background: false } }
      : undefined
  if (
    command !== "dev" &&
    command !== "prod" &&
    command !== "stop" &&
    command !== "status" &&
    command !== "doctor"
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

const pidFile = pidFilePath
const logFile = logFilePath

function probeWith(fetch: Fetch): Probe {
  return async (url) => {
    try {
      return (await fetch(url)).status
    } catch {
      return undefined
    }
  }
}

export async function argsOf(
  exec: Exec,
  pid: number,
  platform: Platform = "linux"
): Promise<string | undefined> {
  return processControl(platform, exec).argsOf(pid)
}

async function tailscaleHost(deps: Deps): Promise<string> {
  const bin = tailscaleBin(deps.platform)
  const run = await deps.exec(bin, ["status", "--json"])
  if (run.code !== 0)
    throw new Error(
      `${bin} status --json failed: ${run.stderr.trim() || `exit ${run.code}`}. Is Tailscale running? Use --no-serve for backends only.`
    )
  return parseDnsName(run.stdout)
}

/** The tailnet host: EIDO_TAILNET_HOST, else Self.DNSName from tailscale when serving, else localhost. */
export async function resolveHost(deps: Deps, serve: boolean): Promise<string> {
  const fromEnv = deps.env["EIDO_TAILNET_HOST"]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  return serve ? await tailscaleHost(deps) : "localhost"
}

export function configFor(
  deps: Deps,
  mode: Mode,
  tailnetHost: string
): StackConfig {
  return buildStackConfig({
    mode,
    platform: deps.platform,
    env: deps.env,
    home: deps.home,
    repoRoot: deps.repoRoot,
    nodePath: deps.nodePath,
    tailnetHost,
  })
}

function serveDeps(deps: Deps) {
  const bin = tailscaleBin(deps.platform)
  return {
    tailscale: (args: readonly string[]) => deps.exec(bin, args),
    fetch: deps.fetch,
    out: (line: string) => deps.out(`serve | ${line}`),
    err: (line: string) => deps.err(`serve | ${line}`),
  }
}

export function readRecord(
  deps: Deps,
  config: StackConfig,
  name: ProcessName
): PidRecord | undefined {
  const text = deps.files.read(pidFile(config, name))
  return text === undefined ? undefined : parsePidRecord(text)
}

/** Stops the named processes in reverse start order and removes their pid files. */
export async function stopAll(
  deps: Deps,
  config: StackConfig,
  names: readonly ProcessName[]
) {
  const control =
    deps.control ??
    processControl(deps.platform, deps.exec, {
      signalGroup: deps.signalGroup,
      groupAlive: deps.groupAlive,
    })
  const stopDeps = {
    argsOf: (pid: number) => control.argsOf(pid),
    control,
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

export function doctorDeps(deps: Deps): DoctorDeps {
  return {
    platform: deps.platform,
    env: deps.env,
    home: deps.home,
    repoRoot: deps.repoRoot,
    nodeVersion: deps.nodeVersion,
    exec: deps.exec,
    fetch: deps.fetch,
    files: deps.files,
    sha256: deps.sha256,
    now: deps.clock.now,
  }
}

async function doctor(deps: Deps, flags: Flags): Promise<number> {
  const checks = await runDoctor(doctorDeps(deps), {
    serve: flags.serve,
    quick: false,
  })
  for (const check of checks)
    for (const line of formatCheck(check)) deps.out(line)
  const failures = failed(checks).length
  deps.out(
    failures === 0
      ? "doctor: no failures"
      : `doctor: ${failures} failure${failures === 1 ? "" : "s"}`
  )
  return failures === 0 ? 0 : 1
}

/** Doctor's failures that block a start. Ports are left to start's own check, which is stricter. */
async function preflight(deps: Deps, flags: Flags): Promise<boolean> {
  const checks = await runDoctor(doctorDeps(deps), {
    serve: flags.serve,
    quick: true,
  })
  // The stack runs without inference: a missing model or a stopped llama-server is the Admin
  // page's to fix (#628), so neither blocks a start. A model that fails its pin still does.
  const blocking = failed(checks).filter(
    (check) => check.id !== "ports" && check.startsWithoutIt !== true
  )
  for (const check of blocking)
    for (const line of formatCheck(check)) deps.err(line)
  return blocking.length === 0
}

/** The gate's environment as start would give it. The host only shapes WebAuthn settings, which
 *  the gate CLIs do not read, so a missing Tailscale falls back to localhost. */
async function gateSpec(deps: Deps): Promise<ProcessSpec> {
  let host: string
  try {
    host = await resolveHost(deps, true)
  } catch {
    host = "localhost"
  }
  const gate = configFor(deps, "prod", host).processes.find(
    (spec) => spec.name === "gate"
  )
  // buildStackConfig always returns gate, core and web.
  if (gate === undefined) throw new Error("no gate process in the stack config")
  return gate
}

/**
 * The node arguments of a gate script in packages/gate/package.json, which runs them as
 * `node <args>`. Running node directly needs no pnpm shell, so it works the same on Windows.
 */
export function gateScriptArgs(
  packageJson: string | undefined,
  script: GateScript
): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(packageJson ?? "")
  } catch {
    parsed = undefined
  }
  const scripts: unknown =
    typeof parsed === "object" && parsed !== null
      ? Object.entries(parsed).find(([key]) => key === "scripts")?.[1]
      : undefined
  const line: unknown =
    typeof scripts === "object" && scripts !== null
      ? Object.entries(scripts).find(([name]) => name === script)?.[1]
      : undefined
  const words = typeof line === "string" ? line.trim().split(/\s+/) : []
  if (words[0] !== "node" || words.some((word) => /["'`$&|;<>]/.test(word)))
    throw new Error(
      `packages/gate/package.json has no plain "node ..." script named ${script}`
    )
  return words.slice(1)
}

async function gate(
  deps: Deps,
  script: GateScript,
  args: readonly string[]
): Promise<number> {
  const spec = await gateSpec(deps)
  const packageJson = deps.files.read(
    pathsFor(deps.platform).join(spec.cwd, "package.json")
  )
  return await deps.interactive(
    deps.nodePath,
    [...gateScriptArgs(packageJson, script), ...args],
    { cwd: spec.cwd, env: spec.env }
  )
}

/**
 * Starts `specs` in order, each once the one before answers, with a pid file each. On a failure
 * it reports it, stops what it started and returns the failure.
 */
export async function launchInOrder(
  deps: Deps,
  config: StackConfig,
  specs: readonly ProcessSpec[],
  mode: Mode,
  background: boolean
): Promise<{ started: Started[]; failure: string | undefined }> {
  const probe = probeWith(deps.fetch)
  const { started, failure } = await startInOrder(specs, {
    launch: (spec) => {
      const launched = deps.launch(spec, {
        logFile: logFile(config, spec.name),
        background,
        prefixOutput: mode === "dev" && !background,
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
  if (failure !== undefined) {
    const last = started.at(-1)?.spec.name ?? specs[0]?.name ?? "gate"
    deps.err(`FAIL: ${failure}; see ${logFile(config, last)}`)
    await stopAll(
      deps,
      config,
      started.map((s) => s.spec.name)
    )
  }
  return { started, failure }
}

/** Whether the pid file names a live process that still carries the stack's marker. */
export async function isRunning(
  deps: Deps,
  config: StackConfig,
  name: ProcessName
): Promise<boolean> {
  const record = readRecord(deps, config, name)
  return (
    record !== undefined &&
    (await argsOf(deps.exec, record.pid, deps.platform))?.includes(
      record.marker
    ) === true
  )
}

async function start(deps: Deps, mode: Mode, flags: Flags): Promise<number> {
  if (!(await preflight(deps, flags))) {
    deps.err(
      "Nothing was started. Run pnpm stack:doctor for every check, or pnpm stack:setup."
    )
    return 1
  }
  const config = configFor(deps, mode, await resolveHost(deps, flags.serve))

  const busy = await busyPorts(
    deps.exec,
    config.processes.map((spec) => ({
      name: spec.name,
      port: spec.port,
      variable: PORT_VARIABLES[spec.name],
    })),
    deps.platform
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

  const { started, failure } = await launchInOrder(
    deps,
    config,
    config.processes,
    mode,
    flags.background
  )
  if (failure !== undefined) return 1

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
    const listeners = await listenersOn(deps.exec, spec.port, deps.platform)
    if (listeners.length === 0) continue
    left++
    deps.out(
      `port ${spec.port} (${spec.name}) still has a listener the stack did not start: ${describeListeners(listeners)}; left alone`
    )
  }
  if (left === 0) deps.out("Nothing listens on the stack's ports.")
  if ((await readAgentState(deps)).kind === "loaded")
    deps.out(
      "The login agent is loaded: it starts the stack again at the next login or supervisor restart. To stop that, pnpm stack:uninstall."
    )
  return 0
}

/** The agent's state; `unsupported` off macOS or without a user id. */
export async function readAgentState(deps: Deps): Promise<AgentState> {
  const uid = deps.platform === "darwin" ? deps.uid : undefined
  if (uid === undefined) return agentState(undefined, false)
  const printed = await deps.exec("launchctl", agentPrintArgs(uid))
  return agentState(
    printed,
    deps.files.exists(agentLayout(deps.home).plistPath)
  )
}

function agentUid(deps: Deps, command: string): number | undefined {
  const uid = deps.platform === "darwin" ? deps.uid : undefined
  if (uid === undefined)
    deps.err(
      `FAIL: stack ${command} needs launchd and is macOS only so far; Task Scheduler on Windows is #455`
    )
  return uid
}

/** Writes the agent's plist (and its log directory) without loading it; launchd reads it at login. */
export function writeAgentPlist(deps: Deps): void {
  const paths = agentLayout(deps.home)
  deps.files.ensurePrivateDir(paths.logDir)
  deps.files.write(
    paths.plistPath,
    buildAgentPlist({
      home: deps.home,
      node: deps.nodePath,
      repoRoot: deps.repoRoot,
      env: agentEnv(deps.env),
    })
  )
}

async function installAgent(deps: Deps): Promise<number> {
  const uid = agentUid(deps, "install")
  if (uid === undefined) return 1
  const paths = agentLayout(deps.home)
  // bootstrap refuses a label that is already loaded, so a re-install boots the old job out first.
  if ((await deps.exec("launchctl", agentPrintArgs(uid))).code === 0)
    await deps.exec("launchctl", agentBootoutArgs(uid))
  writeAgentPlist(deps)
  const run = await deps.exec(
    "launchctl",
    agentBootstrapArgs(uid, paths.plistPath)
  )
  if (run.code !== 0) {
    deps.err(
      `FAIL: launchctl bootstrap: ${run.stderr.trim() || `exit ${run.code}`}`
    )
    return 1
  }
  deps.out(`ok: ${agentTarget(uid)} loaded from ${paths.plistPath}`)
  deps.out(
    "It runs the stack supervisor now and at every login, and the supervisor starts the prod stack."
  )
  deps.out(`logs: ${paths.outLog} and ${paths.errLog}`)
  return 0
}

async function uninstall(deps: Deps): Promise<number> {
  const uid = agentUid(deps, "uninstall")
  if (uid === undefined) return 1
  const paths = agentLayout(deps.home)
  if ((await deps.exec("launchctl", agentPrintArgs(uid))).code === 0) {
    const run = await deps.exec("launchctl", agentBootoutArgs(uid))
    if (run.code !== 0) {
      deps.err(
        `FAIL: launchctl bootout: ${run.stderr.trim() || `exit ${run.code}`}`
      )
      return 1
    }
  }
  if (deps.files.exists(paths.plistPath)) deps.files.remove(paths.plistPath)
  deps.out(`ok: ${agentTarget(uid)} is not loaded and its plist is gone`)
  deps.out(
    "The stack's processes keep running; stop them with pnpm stack:stop."
  )
  return 0
}

/** The agent's first step: start prod in the background, unless any stack process runs. */
async function boot(deps: Deps): Promise<number> {
  const config = configFor(deps, "prod", "localhost")
  const running: ProcessName[] = []
  for (const spec of config.processes)
    if (await isRunning(deps, config, spec.name)) running.push(spec.name)
  if (running.length > 0) {
    deps.out(
      `boot: ${running.join(", ")} already running; the stack is left as it is`
    )
    return 0
  }
  return await start(deps, "prod", { serve: true, background: true })
}

async function status(deps: Deps, flags: Flags): Promise<number> {
  const config = configFor(deps, "dev", await resolveHost(deps, flags.serve))
  const probe = probeWith(deps.fetch)
  let healthy = 0
  for (const spec of config.processes) {
    const record = readRecord(deps, config, spec.name)
    const running = await isRunning(deps, config, spec.name)
    const state =
      record === undefined
        ? "not started by the stack"
        : running
          ? `running (pid ${record.pid}, ${record.mode})`
          : `stale pid file (pid ${record.pid} is gone)`
    const listeners = await listenersOn(deps.exec, spec.port, deps.platform)
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
  deps.out(agentStatusLine(await readAgentState(deps)))
  return healthy === config.processes.length && serveCode === 0 ? 0 : 1
}

/**
 * The end of setup (#660): with the gate running, issue the first phone enrolment code and say
 * where to enter it (doctor then reports the stack's own ports as in use, so this does not wait
 * on doctor). With the gate stopped and doctor clean, say how to get one once the stack is up.
 */
async function firstCode(deps: Deps, healthy: boolean): Promise<number> {
  let host: string
  try {
    host = await resolveHost(deps, true)
  } catch {
    host = "localhost"
  }
  const config = configFor(deps, "prod", host)
  const enrol = new URL("enroll", config.url).href
  if (!(await isRunning(deps, config, "gate"))) {
    if (healthy)
      deps.out(
        `To enrol your phone: start the stack (pnpm stack:prod), run pnpm stack:gate enrol-code and enter the code at ${enrol}`
      )
    return 0
  }
  if (await passkeyEnrolled(deps, config)) {
    deps.out(
      "A passkey is already enrolled, so no first-run code is issued. To add a phone or recover after a lost one: pnpm stack:gate enrol-code"
    )
    return 0
  }
  const code = await gate(deps, "enrol-code", [])
  if (code === 0) deps.out(`Enter the code on your phone at ${enrol}`)
  return code
}

/** Whether the running gate reports a passkey (GET /passkey/status, `enrolled`); false when it cannot be read. */
async function passkeyEnrolled(
  deps: Deps,
  config: StackConfig
): Promise<boolean> {
  const url = config.processes.find((spec) => spec.name === "gate")?.healthUrl
  if (url === undefined) return false
  try {
    const body: unknown = JSON.parse(await (await deps.fetch(url)).text())
    return (
      typeof body === "object" &&
      body !== null &&
      Object.entries(body).some(
        ([key, value]) => key === "enrolled" && value === true
      )
    )
  } catch {
    return false
  }
}

/** `pnpm install` through the pnpm that ran this command when there is one, else `pnpm` on the path. */
function pnpmCommand(
  deps: Deps,
  args: readonly string[]
): { command: string; args: string[] } {
  const script = deps.env["npm_execpath"]
  return script !== undefined && /pnpm/.test(script)
    ? { command: deps.nodePath, args: [script, ...args] }
    : { command: "pnpm", args: [...args] }
}

/** The first run as one command (#648); see the header. */
async function bootstrap(
  deps: Deps,
  settingsPath: string,
  fileSettings: StackSettings
): Promise<number> {
  const run = async (what: string, command: string, args: string[]) => {
    deps.out(`$ ${what}`)
    const code = await deps.interactive(command, args, { cwd: deps.repoRoot })
    if (code !== 0) deps.err(`FAIL: ${what} exited with code ${code}`)
    return code
  }
  const install = pnpmCommand(deps, ["install", "--frozen-lockfile"])
  let code = await run(
    "pnpm install --frozen-lockfile",
    install.command,
    install.args
  )
  if (code !== 0) return code
  code = await run("llama fetch --build-only", deps.nodePath, [
    "--disable-warning=ExperimentalWarning",
    pathsFor(deps.platform).join(deps.repoRoot, "infra", "llama", "bin.ts"),
    "fetch",
    "--build-only",
  ])
  if (code !== 0) return code
  code = await runSetup(deps, settingsPath, fileSettings)
  if (code !== 0) return code
  const setUp: Deps = {
    ...deps,
    env: applyStackSettings(
      deps.env,
      readStackSettings(deps.files, settingsPath, deps.platform)
    ),
  }
  code = await boot(setUp)
  if (code !== 0) return code
  if (deps.platform === "darwin") {
    code = await installAgent(setUp)
    if (code !== 0) return code
  } else
    deps.out(
      "Start at login is macOS only so far (Task Scheduler on Windows is #455); after a restart run pnpm stack:prod --background."
    )
  return await firstCode(setUp, true)
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
    const settingsPath = stackSettingsPath(deps.env, deps.home, deps.platform)
    const fileSettings = readStackSettings(
      deps.files,
      settingsPath,
      deps.platform
    )
    const withSettings: Deps = {
      ...deps,
      env: applyStackSettings(deps.env, fileSettings),
    }
    switch (parsed.command) {
      case "dev":
      case "prod":
        return await start(withSettings, parsed.command, parsed.flags)
      case "stop":
        return await stop(withSettings)
      case "status":
        return await status(withSettings, parsed.flags)
      case "doctor":
        return await doctor(withSettings, parsed.flags)
      case "setup": {
        const code = await runSetup(withSettings, settingsPath, fileSettings)
        if (code !== 0) return code
        const written = readStackSettings(
          deps.files,
          settingsPath,
          deps.platform
        )
        const setUp: Deps = {
          ...deps,
          env: applyStackSettings(deps.env, written),
        }
        const checked = await doctor(setUp, parsed.flags)
        const issued = await firstCode(setUp, checked === 0)
        return issued === 0 ? checked : issued
      }
      case "bootstrap":
        return await bootstrap(deps, settingsPath, fileSettings)
      case "install":
        return await installAgent(withSettings)
      case "uninstall":
        return await uninstall(withSettings)
      case "boot":
        return await boot(withSettings)
      case "gate":
        return await gate(withSettings, parsed.script, parsed.args)
    }
  } catch (error) {
    deps.err(`FAIL: ${(error as Error).message}`)
    return 1
  }
}
