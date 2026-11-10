// The stack supervisor's routes (#644, ADR 0009 Decision 6). It runs as the owner, listens only on
// a Unix socket (supervisor-server.ts) and answers a fixed set of routes, each body checked by its
// schema in @eido/schemas:
//   GET  /doctor                          the doctor checks, quick (no model hash)
//   GET  /jobs                            gate, core, web and llama, and the model fetch tasks
//   POST /jobs/start|stop|restart         core and llama only; the gate, web and the supervisor stay
//   GET  /models, POST /models/use        the model profiles; make one active
//   POST /models/fetch                    download a profile's model as a task GET /jobs reports
//   GET  /settings, POST /settings        stack.env, with the file's SHA-256 a write must name
//   GET  /login-item, POST /login-item    start at login: the login agent's plist, macOS only (#664)
// Every other route is 404. Starts, stops and fetches run after the reply (202); GET /jobs shows
// their progress. It parents nothing: core runs from its pid file as `pnpm stack:*` starts it, and
// llama-server is launchd's job.
import { createHash } from "node:crypto"

import {
  validateStackJobRequest,
  validateStackLoginItemRequest,
  validateStackModelRequest,
  validateStackSettingsWrite,
  type StackDoctorReport,
  type StackError,
  type StackJobStatus,
  type StackLoginItem,
  type StackModelList,
  type ValidationResult,
} from "@eido/schemas"

import {
  main as llamaMain,
  loadBase,
  profileRows,
  type Deps as LlamaDeps,
} from "../llama/cli.ts"
import {
  bootoutArgs,
  bootstrapArgs,
  kickstartArgs,
  layout,
  parsePrint,
  printArgs,
} from "../llama/launchd.ts"
import { modelPathOf } from "../llama/lock.ts"
import { agentBootoutArgs, agentLayout } from "./agent.ts"
import {
  configFor,
  doctorDeps,
  isRunning,
  launchInOrder,
  readAgentState,
  readRecord,
  resolveHost,
  stopAll,
  writeAgentPlist,
  type Deps as StackDeps,
} from "./cli.ts"
import { pathsFor, stackDirOf, type StackConfig } from "./config.ts"
import { runDoctor } from "./doctor.ts"
import {
  applyStackSettings,
  formatStackSettings,
  isSettingKey,
  readStackSettings,
  apiSettingProblem,
  stackSettingsPath,
  type StackSettings,
} from "./settings.ts"

export type SupervisorDeps = {
  /** The stack CLI's effects, with the environment as the supervisor was started with. */
  stack: StackDeps
  /** The llama CLI's effects. */
  llama: LlamaDeps
  /** launchd's gui domain; undefined off macOS. */
  uid: number | undefined
  /** The supervisor's own process id: turning start at login off never boots out its own job. */
  pid: number
  /** Replaces the file atomically at mode 0600. */
  writeSettings: (path: string, text: string) => void
  log: (line: string) => void
}

export type Reply = { status: number; body: unknown }

type Controlled = "core" | "llama"
type Kind = "start" | "stop" | "restart"
type Transition = "starting" | "stopping"
type ProcessRow = StackJobStatus["processes"][number]
type TaskRow = StackJobStatus["tasks"][number]

type Task = Omit<TaskRow, "receivedBytes"> & {
  /** The download while it runs. */
  partialPath: string
}

/** Where the supervisor listens: beside the gate's sockets, in the stack's private run directory. */
export const supervisorSocketPath = (
  stack: Pick<StackDeps, "platform" | "env" | "home">
): string => {
  return pathsFor(stack.platform).join(
    stackDirOf(stack.platform, stack.env, stack.home),
    "run",
    "supervisor.sock"
  )
}

const MAX_TASKS = 32
const MAX_TEXT = 2000
const CONTROLLED: readonly Controlled[] = ["core", "llama"]
const LLAMA_NOT_INSTALLED =
  "com.eido.llama-server is not installed; run pnpm --filter @eido/infra llama install"
const LLAMA_OFF_MAC =
  "llama-server runs under launchd, on macOS only so far (#629)"
const LOGIN_OFF_MAC =
  "start at login needs launchd, on macOS only so far; Task Scheduler on Windows is #455"

const clip = (text: string): string =>
  text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`
const messageOf = (error: unknown): string =>
  clip(error instanceof Error ? error.message : String(error))
const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex")

const refuse = (
  status: number,
  error: StackError["error"],
  message: string
): Reply => ({
  status,
  body: { error, message: clip(message) } satisfies StackError,
})

/** The body, parsed and checked by its schema, or the 400 that refuses it. */
function parseBody<T>(
  text: string,
  validate: (value: unknown) => ValidationResult<T>
): { ok: true; value: T } | { ok: false; reply: Reply } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {
      ok: false,
      reply: refuse(400, "invalid_body", "the body is not JSON"),
    }
  }
  const checked = validate(value)
  return checked.ok
    ? checked
    : {
        ok: false,
        reply: refuse(400, "invalid_body", checked.errors.join("; ")),
      }
}

export function createSupervisor(deps: SupervisorDeps) {
  const transitions = new Map<Controlled, Transition>()
  const failures = new Map<Controlled, string>()
  const tasks: Task[] = []
  let taskCount = 0
  let operation: Promise<void> | undefined
  let fetching: Promise<void> | undefined

  const settingsPath = () =>
    stackSettingsPath(deps.stack.env, deps.stack.home, deps.stack.platform)

  /** The stack's effects with stack.env applied, read again on every call as the CLI does. */
  const stack = (): StackDeps => ({
    ...deps.stack,
    env: applyStackSettings(
      deps.stack.env,
      readStackSettings(deps.stack.files, settingsPath(), deps.stack.platform)
    ),
  })
  // Pid files live in the run directory, which neither the mode nor the host changes.
  const pidConfig = (s: StackDeps): StackConfig =>
    configFor(s, "dev", "localhost")

  const launchctl = (args: readonly string[]) =>
    deps.llama.run("launchctl", args)
  const mustLaunchctl = async (args: readonly string[]) => {
    const run = await launchctl(args)
    if (run.code !== 0)
      throw new Error(
        `launchctl ${args[0]}: ${run.stderr.trim() || `exit ${run.code}`}`
      )
  }
  const llamaUid = () =>
    deps.stack.platform === "darwin" ? deps.uid : undefined
  const llamaPlist = () => layout(deps.llama.home).plistPath

  async function llamaState(): Promise<Pick<ProcessRow, "state" | "message">> {
    const uid = llamaUid()
    if (uid === undefined)
      return { state: "unavailable", message: LLAMA_OFF_MAC }
    const printed = await launchctl(printArgs(uid))
    if (printed.code === 0)
      return {
        state:
          parsePrint(printed.stdout).state === "running"
            ? "running"
            : "stopped",
      }
    return deps.llama.fs.exists(llamaPlist())
      ? { state: "stopped" }
      : { state: "unavailable", message: LLAMA_NOT_INSTALLED }
  }

  /** Why `name` cannot be started now, or undefined when it can. */
  async function startRefusal(name: Controlled): Promise<Reply | undefined> {
    if (name === "llama") {
      const state = await llamaState()
      return state.state === "unavailable"
        ? refuse(409, "unavailable", state.message ?? LLAMA_NOT_INSTALLED)
        : undefined
    }
    const s = stack()
    return (await isRunning(s, pidConfig(s), "gate"))
      ? undefined
      : refuse(
          409,
          "stack_not_running",
          "the gate is not running; start the stack with pnpm stack:prod --background"
        )
  }

  const steps: Record<
    Controlled,
    Record<"start" | "stop" | "restart", () => Promise<void>>
  > = {
    core: {
      stop: async () => {
        const s = stack()
        await stopAll(s, pidConfig(s), ["core"])
      },
      start: async () => {
        const s = stack()
        const base = pidConfig(s)
        if (await isRunning(s, base, "core")) return
        const gate = readRecord(s, base, "gate")
        if (gate === undefined || !(await isRunning(s, base, "gate")))
          throw new Error("the gate is not running")
        let host: string
        try {
          host = await resolveHost(s, true)
        } catch {
          host = "localhost"
        }
        const config = configFor(s, gate.mode, host)
        const core = config.processes.filter((spec) => spec.name === "core")
        const { failure } = await launchInOrder(
          s,
          config,
          core,
          gate.mode,
          true
        )
        if (failure !== undefined) throw new Error(failure)
      },
      restart: async () => {
        await steps.core.stop()
        await steps.core.start()
      },
    },
    llama: {
      stop: async () => {
        const uid = llamaUid()
        if (uid === undefined) return
        if ((await launchctl(printArgs(uid))).code === 0)
          await mustLaunchctl(bootoutArgs(uid))
      },
      start: async () => {
        const uid = llamaUid()
        if (uid === undefined) throw new Error(LLAMA_OFF_MAC)
        if ((await launchctl(printArgs(uid))).code !== 0) {
          if (!deps.llama.fs.exists(llamaPlist()))
            throw new Error(LLAMA_NOT_INSTALLED)
          await mustLaunchctl(bootstrapArgs(uid, llamaPlist()))
          return
        }
        if ((await llamaState()).state !== "running")
          await mustLaunchctl(kickstartArgs(uid))
      },
      restart: async () => {
        const uid = llamaUid()
        if (uid !== undefined && (await launchctl(printArgs(uid))).code === 0)
          await mustLaunchctl(kickstartArgs(uid))
        else await steps.llama.start()
      },
    },
  }

  /** Marks the processes in transition now; the work waits for `begin`, after the reply's snapshot. */
  function runOperation(
    kind: Kind,
    names: readonly Controlled[],
    begin: Promise<void>
  ) {
    for (const name of names)
      transitions.set(name, kind === "stop" ? "stopping" : "starting")
    operation = (async () => {
      await begin
      for (const name of names) {
        failures.delete(name)
        if (kind === "restart") transitions.set(name, "stopping")
        try {
          await steps[name][kind]()
        } catch (error) {
          failures.set(name, `${kind} failed: ${messageOf(error)}`)
          deps.log(`supervisor | ${name} ${kind} failed: ${messageOf(error)}`)
        }
        transitions.delete(name)
      }
    })().finally(() => {
      operation = undefined
    })
  }

  async function processRows(): Promise<ProcessRow[]> {
    const s = stack()
    const config = pidConfig(s)
    const rows: ProcessRow[] = []
    for (const name of ["gate", "core", "web"] as const) {
      const running = await isRunning(s, config, name)
      rows.push({
        name,
        state: running ? "running" : "stopped",
        controllable: name === "core",
      })
    }
    rows.push({ name: "llama", ...(await llamaState()), controllable: true })
    return rows.map((row) => {
      if (row.name !== "core" && row.name !== "llama") return row
      const transition = transitions.get(row.name)
      const failure = failures.get(row.name)
      return {
        ...row,
        ...(transition === undefined ? {} : { state: transition }),
        ...(failure === undefined ? {} : { message: failure }),
      }
    })
  }

  async function taskRows(): Promise<TaskRow[]> {
    const rows: TaskRow[] = []
    for (const { partialPath, ...task } of tasks) {
      const received =
        task.state === "succeeded"
          ? task.totalBytes
          : ((await deps.llama.probe.size(partialPath)) ?? 0)
      // A size above the pinned one is a bad download; it is never reported as more than done.
      rows.push({ ...task, receivedBytes: Math.min(received, task.totalBytes) })
    }
    return rows
  }

  async function jobStatus(): Promise<StackJobStatus> {
    return { processes: await processRows(), tasks: await taskRows() }
  }

  /** Runs a llama CLI command; its output goes to the log and its last FAIL is the message. */
  async function llamaCommand(argv: readonly string[]) {
    const errors: string[] = []
    const code = await llamaMain(argv, {
      ...deps.llama,
      settings: { ...deps.llama.settings, write: deps.writeSettings },
      out: (line) => deps.log(`llama | ${line}`),
      err: (line) => {
        errors.push(line)
        deps.log(`llama | ${line}`)
      },
    })
    const last = errors.at(-1)?.replace(/^FAIL: /, "")
    return { code, message: clip(last ?? `llama ${argv[0]} exited ${code}`) }
  }

  async function modelList(): Promise<StackModelList> {
    const { active, rows } = await profileRows(deps.llama, loadBase(deps.llama))
    return {
      active,
      profiles: rows.map(({ profile, disk, verified, isDefault }) => ({
        id: profile.id,
        model: profile.model,
        quantization: profile.quantization,
        sizeBytes: profile.size,
        disk: disk.kind,
        verified,
        origin: profile.origin,
        isDefault,
      })),
    }
  }

  async function jobs(kind: Kind, body: string): Promise<Reply> {
    const parsed = parseBody(body, validateStackJobRequest)
    if (!parsed.ok) return parsed.reply
    if (operation !== undefined)
      return refuse(409, "busy", "another start, stop or restart is running")
    const names = CONTROLLED.filter((name) => parsed.value.names.includes(name))
    if (kind !== "stop")
      for (const name of names) {
        const refusal = await startRefusal(name)
        if (refusal !== undefined) return refusal
      }
    let release = () => {}
    runOperation(
      kind,
      names,
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    try {
      return { status: 202, body: await jobStatus() }
    } finally {
      release()
    }
  }

  async function useModel(body: string): Promise<Reply> {
    const parsed = parseBody(body, validateStackModelRequest)
    if (!parsed.ok) return parsed.reply
    const { id } = parsed.value
    if (!loadBase(deps.llama).lock.profiles.some((p) => p.id === id))
      return refuse(404, "not_found", `no model profile ${id}`)
    const run = await llamaCommand(["use", id])
    if (run.code !== 0) return refuse(409, "failed", run.message)
    return { status: 200, body: await modelList() }
  }

  async function fetchModel(body: string): Promise<Reply> {
    const parsed = parseBody(body, validateStackModelRequest)
    if (!parsed.ok) return parsed.reply
    const { id } = parsed.value
    const base = loadBase(deps.llama)
    const profile = base.lock.profiles.find((p) => p.id === id)
    if (profile === undefined)
      return refuse(404, "not_found", `no model profile ${id}`)
    if (fetching !== undefined)
      return refuse(409, "busy", "a model download is running")
    const modelPath = modelPathOf(
      profile,
      base.config.modelDir,
      base.config.join
    )
    taskCount++
    const task: Task = {
      id: `task-${taskCount}`,
      kind: "model.fetch",
      profile: id,
      state: "running",
      startedAt: new Date(deps.stack.clock.now()).toISOString(),
      totalBytes: profile.size,
      partialPath: `${modelPath}.partial`,
    }
    tasks.push(task)
    if (tasks.length > MAX_TASKS) tasks.shift()
    fetching = llamaCommand(["fetch", "--model", id])
      .then(
        (run) => {
          task.state = run.code === 0 ? "succeeded" : "failed"
          if (run.code !== 0) task.message = run.message
        },
        (error: unknown) => {
          task.state = "failed"
          task.message = messageOf(error)
        }
      )
      .finally(() => {
        fetching = undefined
      })
    return { status: 202, body: await jobStatus() }
  }

  function readSettings(): { sha256: string | null; settings: StackSettings } {
    const path = settingsPath()
    const settings = readStackSettings(
      deps.stack.files,
      path,
      deps.stack.platform
    )
    const text = deps.stack.files.read(path)
    return { sha256: text === undefined ? null : sha256(text), settings }
  }

  function writeSettings(body: string): Reply {
    const parsed = parseBody(body, validateStackSettingsWrite)
    if (!parsed.ok) return parsed.reply
    const current = readSettings()
    if (parsed.value.expectedSha256 !== current.sha256)
      return refuse(
        409,
        "stale_settings",
        "stack.env changed since it was read; read it again"
      )
    const next = { ...current.settings }
    for (const [key, value] of Object.entries(parsed.value.set)) {
      const problem = apiSettingProblem(key, value)
      if (problem !== undefined || !isSettingKey(key))
        return refuse(
          400,
          "invalid_body",
          problem ?? `${key} is not a stack setting`
        )
      if (value === "") delete next[key]
      else next[key] = value
    }
    const path = settingsPath()
    const text = formatStackSettings(next)
    deps.stack.files.ensurePrivateDir(
      pathsFor(deps.stack.platform).dirname(path)
    )
    deps.writeSettings(path, text)
    return { status: 200, body: { sha256: sha256(text), settings: next } }
  }

  /**
   * Start at login is the login agent's plist: launchd loads it at the next login. Turning it on
   * writes the plist without loading it now, so no second supervisor starts beside this one;
   * turning it off removes the plist, and boots the agent out unless the loaded job is this
   * supervisor, which keeps serving until logout.
   */
  async function loginItem(body?: string): Promise<Reply> {
    const s = stack()
    const uid = s.platform === "darwin" ? s.uid : undefined
    if (uid === undefined) return refuse(501, "unsupported", LOGIN_OFF_MAC)
    let enable: boolean | undefined
    if (body !== undefined) {
      const parsed = parseBody(body, validateStackLoginItemRequest)
      if (!parsed.ok) return parsed.reply
      enable = parsed.value.enabled
    }
    const state = await readAgentState(s)
    if (enable === true) writeAgentPlist(s)
    if (enable === false) {
      if (state.kind === "loaded" && state.job.pid !== deps.pid) {
        const run = await s.exec("launchctl", agentBootoutArgs(uid))
        if (run.code !== 0)
          return refuse(
            409,
            "failed",
            `launchctl bootout: ${run.stderr.trim() || `exit ${run.code}`}`
          )
      }
      const plist = agentLayout(s.home).plistPath
      if (s.files.exists(plist)) s.files.remove(plist)
    }
    if (enable !== undefined)
      deps.log(`supervisor | start at login ${enable ? "on" : "off"}`)
    const enabled =
      enable ??
      (state.kind === "not loaded" || (state.kind === "loaded" && state.plist))
    return { status: 200, body: { enabled } satisfies StackLoginItem }
  }

  async function doctor(): Promise<StackDoctorReport> {
    const checks = await runDoctor(doctorDeps(stack()), {
      serve: true,
      quick: true,
    })
    return {
      checks: checks.map(({ id, status, summary, fix }) => ({
        id,
        status,
        summary: clip(summary),
        ...(fix === undefined
          ? {}
          : { fix: { action: fix.action, text: clip(fix.text) } }),
      })),
    }
  }

  async function route(
    method: string,
    path: string,
    body: string
  ): Promise<Reply> {
    switch (`${method} ${path}`) {
      case "GET /doctor":
        return { status: 200, body: await doctor() }
      case "GET /jobs":
        return { status: 200, body: await jobStatus() }
      case "POST /jobs/start":
        return jobs("start", body)
      case "POST /jobs/stop":
        return jobs("stop", body)
      case "POST /jobs/restart":
        return jobs("restart", body)
      case "GET /models":
        return { status: 200, body: await modelList() }
      case "POST /models/use":
        return useModel(body)
      case "POST /models/fetch":
        return fetchModel(body)
      case "GET /settings":
        return { status: 200, body: readSettings() }
      case "POST /settings":
        return writeSettings(body)
      case "GET /login-item":
        return loginItem()
      case "POST /login-item":
        return loginItem(body)
      default:
        return refuse(404, "not_found", `no route ${method} ${path}`)
    }
  }

  return {
    async handle(method: string, path: string, body: string): Promise<Reply> {
      try {
        return await route(method, path, body)
      } catch (error) {
        deps.log(`supervisor | ${method} ${path} failed: ${messageOf(error)}`)
        return refuse(500, "failed", messageOf(error))
      }
    },
    /** Resolves once the running start, stop or restart and model download are done. */
    async settled(): Promise<void> {
      await operation
      await fetching
    },
  }
}

export type Supervisor = ReturnType<typeof createSupervisor>
