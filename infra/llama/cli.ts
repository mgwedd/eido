// `pnpm --filter @eido/infra llama <command>`
//   verify                 check llama-server's build and the model's size and SHA-256 against
//                          infra/model.lock; exit 1 on any mismatch
//   verify-archive PATH    check a downloaded llama.cpp release asset against the lock
//   launch                 verify, then run llama-server on 127.0.0.1 with --jinja, wait for
//                          /health and check /props; stays in the foreground (launchd runs this)
//   check-template         against a running server: the rendered prompt for a fixed conversation
//                          matches the reference fixture, and a JSON-schema request returns valid JSON
//   plan                   print the LaunchAgent plist and the launchctl command; changes nothing
//   install / uninstall    write and bootstrap, or boot out and remove, com.eido.llama-server
//   status                 launchd's view of the job, who listens on the port, and /health
// Effects are passed in, so tests never run a real model, binary, launchctl or network.
import { basename, join } from "node:path"

import { loopbackOnlyFinding, parseListeners } from "../host/checks.ts"
import {
  buildConfig,
  launchEnv,
  lockPathFrom,
  type Env,
  type LlamaConfig,
} from "./config.ts"
import {
  bootoutArgs,
  bootstrapArgs,
  buildPlist,
  layout,
  parsePrint,
  printArgs,
  target,
} from "./launchd.ts"
import { parseLock, type ModelLock } from "./lock.ts"
import {
  baseUrl,
  checkJsonSchema,
  checkProps,
  checkRenderedPrompt,
  serverArgs,
  waitHealthy,
  type Fetch,
} from "./server.ts"
import {
  verifyBuild,
  verifyModel,
  type FileProbe,
  type RunResult,
} from "./verify.ts"

export type ServerProcess = {
  /** Resolves with the exit code (1 when killed by a signal). */
  exited: Promise<number>
  kill: (signal: "SIGTERM") => void
}

export type Deps = {
  readText: (path: string) => string
  probe: FileProbe
  run: (command: string, args: readonly string[]) => Promise<RunResult>
  spawn: (command: string, args: readonly string[]) => ServerProcess
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  /** Calls the handler on SIGTERM or SIGINT. */
  onStopSignal: (handler: () => void) => void
  fs: {
    exists: (path: string) => boolean
    mkdir: (path: string) => void
    writeFile: (path: string, text: string) => void
    remove: (path: string) => void
  }
  env: Env
  home: string
  uid: number
  /** Absolute paths of node and of `infra/llama/bin.ts`, for the LaunchAgent. */
  node: string
  launcher: string
  /** `infra/model.lock` in this checkout. */
  defaultLockPath: string
  /** Where the reference prompts live: `<fixtureDir>/<lock.file>.prompt.txt`. */
  fixtureDir: string
  out: (line: string) => void
  err: (line: string) => void
}

/** How long launch waits for /health after starting llama-server (cold load from disk). */
export const READY_TIMEOUT_MS = 180_000

const USAGE =
  "usage: llama verify|verify-archive PATH|launch|check-template|plan|install|uninstall|status"

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

type Loaded = { lock: ModelLock; config: LlamaConfig }

function load(deps: Deps): Loaded {
  const lockPath = lockPathFrom(deps.env, deps.defaultLockPath)
  const lock = parseLock(deps.readText(lockPath))
  return {
    lock,
    config: buildConfig(deps.env, deps.home, deps.defaultLockPath, lock),
  }
}

/** Build first (fast), then the model hash. Logs both digests on a mismatch. */
async function verify(deps: Deps, { lock, config }: Loaded): Promise<boolean> {
  deps.out(
    `pin: ${lock.model} ${lock.quantization} (${lock.file}), llama.cpp ${lock.llamaCppBuild}`
  )
  const build = await verifyBuild(config.binary, lock, deps.run)
  if (!build.ok) {
    deps.err(`FAIL: ${build.message}`)
    return false
  }
  deps.out(
    `ok: ${config.binary} is ${lock.llamaCppBuild} (${lock.llamaCppCommit})`
  )
  const model = await verifyModel(config.modelPath, lock, deps.probe)
  if (!model.ok) {
    deps.err(`FAIL: ${model.message}`)
    return false
  }
  deps.out(
    `ok: ${config.modelPath} sha256 ${model.sha256} (hashed in ${seconds(model.hashMs)})`
  )
  return true
}

async function verifyArchive(
  deps: Deps,
  lock: ModelLock,
  path: string | undefined
): Promise<number> {
  if (path === undefined) {
    deps.err(USAGE)
    return 2
  }
  if (basename(path) !== lock.llamaCppAsset) {
    deps.err(`FAIL: ${path} is not ${lock.llamaCppAsset}`)
    return 1
  }
  if ((await deps.probe.size(path)) === undefined) {
    deps.err(`FAIL: no file at ${path}`)
    return 1
  }
  const actual = await deps.probe.sha256(path)
  if (actual !== lock.llamaCppSha256) {
    deps.err(
      `FAIL: ${path}: sha256 mismatch: expected ${lock.llamaCppSha256}, actual ${actual}`
    )
    return 1
  }
  deps.out(`ok: ${path} sha256 ${actual}`)
  return 0
}

async function launch(deps: Deps, loaded: Loaded): Promise<number> {
  if (!(await verify(deps, loaded))) {
    deps.err("llama-server was not started")
    return 1
  }
  const { lock, config } = loaded
  const args = serverArgs(config.modelPath, config.port)
  deps.out(`$ ${config.binary} ${args.join(" ")}`)
  const child = deps.spawn(config.binary, args)
  let stopping = false
  deps.onStopSignal(() => {
    stopping = true
    child.kill("SIGTERM")
  })
  const ready = await waitHealthy(config.port, READY_TIMEOUT_MS, {
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: deps.probe.now,
    exited: child.exited,
  })
  if (stopping) {
    await child.exited
    return 0
  }
  if (!ready.ok) {
    deps.err(`FAIL: ${ready.message}`)
    child.kill("SIGTERM")
    await child.exited
    return 1
  }
  const props = await checkProps(
    config.port,
    lock.chatTemplateMarker,
    deps.fetch
  )
  if (!props.ok) {
    deps.err(`FAIL: ${props.message}`)
    child.kill("SIGTERM")
    await child.exited
    return 1
  }
  deps.out(
    `ok: llama-server ready on ${baseUrl(config.port)} in ${seconds(ready.ms)}; chat template has ${lock.chatTemplateMarker}`
  )
  const code = await child.exited
  if (stopping) return 0
  deps.err(`llama-server exited with code ${code}`)
  return code === 0 ? 1 : code
}

async function checkTemplate(
  deps: Deps,
  { lock, config }: Loaded
): Promise<number> {
  const referencePath = join(deps.fixtureDir, `${lock.file}.prompt.txt`)
  if (!deps.fs.exists(referencePath)) {
    deps.err(`FAIL: no reference prompt at ${referencePath}`)
    return 1
  }
  const checks = [
    [
      "chat template",
      await checkProps(config.port, lock.chatTemplateMarker, deps.fetch),
    ],
    [
      "rendered prompt",
      await checkRenderedPrompt(
        config.port,
        deps.readText(referencePath),
        deps.fetch
      ),
    ],
    ["JSON-schema request", await checkJsonSchema(config.port, deps.fetch)],
  ] as const
  let code = 0
  for (const [name, check] of checks) {
    if (check.ok) deps.out(`ok: ${name}`)
    else {
      deps.err(`FAIL: ${name}: ${check.message}`)
      code = 1
    }
  }
  if (code === 0)
    deps.out(
      `ok: template check passed on ${lock.llamaCppBuild} with ${lock.file}`
    )
  return code
}

function plist(deps: Deps, config: LlamaConfig): string {
  return buildPlist({
    home: deps.home,
    node: deps.node,
    launcher: deps.launcher,
    env: launchEnv(config),
  })
}

async function install(deps: Deps, { config }: Loaded): Promise<number> {
  for (const [what, path] of [
    ["llama-server", config.binary],
    ["model file", config.modelPath],
  ] as const) {
    if (!deps.fs.exists(path)) {
      deps.err(`FAIL: no ${what} at ${path}; see infra/llama-server.md`)
      return 1
    }
  }
  const paths = layout(deps.home)
  // bootstrap refuses a label that is already loaded, so a re-install boots the old job out first.
  if ((await deps.run("launchctl", printArgs(deps.uid))).code === 0)
    await deps.run("launchctl", bootoutArgs(deps.uid))
  deps.fs.mkdir(paths.logDir)
  deps.fs.writeFile(paths.plistPath, plist(deps, config))
  const run = await deps.run(
    "launchctl",
    bootstrapArgs(deps.uid, paths.plistPath)
  )
  if (run.code !== 0) {
    deps.err(`FAIL: launchctl bootstrap: ${run.stderr.trim() || run.code}`)
    return 1
  }
  deps.out(`ok: ${target(deps.uid)} loaded from ${paths.plistPath}`)
  deps.out(`logs: ${paths.outLog} and ${paths.errLog}`)
  return 0
}

async function uninstall(deps: Deps): Promise<number> {
  const paths = layout(deps.home)
  if ((await deps.run("launchctl", printArgs(deps.uid))).code === 0) {
    const run = await deps.run("launchctl", bootoutArgs(deps.uid))
    if (run.code !== 0) {
      deps.err(`FAIL: launchctl bootout: ${run.stderr.trim() || run.code}`)
      return 1
    }
  }
  if (deps.fs.exists(paths.plistPath)) deps.fs.remove(paths.plistPath)
  deps.out(`ok: ${target(deps.uid)} is not loaded and its plist is gone`)
  return 0
}

async function status(deps: Deps, { config }: Loaded): Promise<number> {
  let code = 0
  const printed = await deps.run("launchctl", printArgs(deps.uid))
  if (printed.code === 0) {
    const job = parsePrint(printed.stdout)
    deps.out(
      `launchd: ${target(deps.uid)} state ${job.state ?? "unknown"}, pid ${job.pid ?? "none"}, runs ${job.runs ?? "unknown"}, last exit ${job.lastExit ?? "none"}`
    )
  } else deps.out(`launchd: ${target(deps.uid)} is not loaded`)

  const lsof = await deps.run("lsof", [
    "-nP",
    `-iTCP:${config.port}`,
    "-sTCP:LISTEN",
    "-Fpcn",
  ])
  const listening = loopbackOnlyFinding(
    config.port,
    parseListeners(lsof.stdout)
  )
  if (listening.ok) deps.out(`ok: ${listening.message}`)
  else {
    deps.err(`FAIL: ${listening.message}`)
    code = 1
  }

  try {
    const health = await deps.fetch(`${baseUrl(config.port)}/health`)
    if (health.status === 200) deps.out("ok: /health 200")
    else {
      deps.err(`FAIL: /health ${health.status}`)
      code = 1
    }
  } catch (error) {
    deps.err(
      `FAIL: /health: ${error instanceof Error ? error.message : String(error)}`
    )
    code = 1
  }
  return code
}

export async function main(
  argv: readonly string[],
  deps: Deps
): Promise<number> {
  const [command, ...rest] = argv
  let loaded: Loaded
  try {
    loaded = load(deps)
  } catch (error) {
    deps.err(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  switch (command) {
    case "verify":
      return (await verify(deps, loaded)) ? 0 : 1
    case "verify-archive":
      return verifyArchive(deps, loaded.lock, rest[0])
    case "launch":
      return launch(deps, loaded)
    case "check-template":
      return checkTemplate(deps, loaded)
    case "plan":
      deps.out(`# ${layout(deps.home).plistPath}`)
      deps.out(plist(deps, loaded.config))
      deps.out(
        `launchctl ${bootstrapArgs(deps.uid, layout(deps.home).plistPath).join(" ")}`
      )
      return 0
    case "install":
      return install(deps, loaded)
    case "uninstall":
      return uninstall(deps)
    case "status":
      return status(deps, loaded)
    default:
      deps.err(USAGE)
      return 2
  }
}
