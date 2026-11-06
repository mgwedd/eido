// `pnpm --filter @eido/infra llama <command>`
//   verify                 check llama-server's build and the active profile's model size and
//                          SHA-256 against infra/model.lock; exit 1 on any mismatch
//   verify-archive PATH    check a downloaded llama.cpp release asset against the lock
//   fetch [--model ID]     download the pinned build and a profile's model (default: the active
//                          one) from the lock's URLs, verify them, and install them
//   list                   each profile: on disk or not, verified or not, added, default, active
//   add REPO FILE [--revision SHA] [--id ID] [--marker TEXT] [--kwargs JSON]
//                          add a Hugging Face GGUF as a profile in the user's own profiles file,
//                          with the size and sha256 the Hub reports at that revision
//   use ID                 make ID the active profile (EIDO_LLAMA_MODEL in the stack settings
//                          file), then restart the LaunchAgent when it is installed
//   launch                 verify, then run llama-server on 127.0.0.1 with --jinja, wait for
//                          /health and check /props; stays in the foreground (launchd runs this).
//                          Refuses a profile that has not passed check-template.
//   check-template [--model ID]
//                          the chat template is the model's, the rendered prompt for a fixed
//                          conversation matches the reference fixture (when there is one), and a
//                          JSON-schema request returns valid JSON. Without --model it checks the
//                          running server; with it, it starts llama-server for that profile, checks
//                          and stops it. A pass is recorded, which verifies the profile here.
//   plan                   print the LaunchAgent plist and the launchctl command; changes nothing
//   install / uninstall    write and bootstrap, or boot out and remove, com.eido.llama-server
//   status                 launchd's view of the job, who listens on the port, and /health
// plan, install, uninstall and status are macOS only (launchd and lsof); the rest also run on
// Windows. Effects and the platform are passed in, so tests never run a real model, binary,
// launchctl or network, and cover both platforms on any host.
import { join, posix, win32 } from "node:path"

import { loopbackOnlyFinding, parseListeners } from "../host/checks.ts"
import {
  buildConfig,
  envValue,
  launchEnv,
  lockPathFrom,
  type Env,
  type LlamaConfig,
  type Platform,
} from "./config.ts"
import { platformOf } from "../stack/config.ts"
import {
  getStackSetting,
  stackSettingsPath,
  writeStackSetting,
  type SettingsFiles,
} from "../stack/settings.ts"
import { fetchBuild, fetchModel, type FetchDeps } from "./fetch.ts"
import { hubFile, profileSection } from "./hf.ts"
import {
  bootoutArgs,
  bootstrapArgs,
  buildPlist,
  kickstartArgs,
  layout,
  parsePrint,
  printArgs,
  target,
} from "./launchd.ts"
import {
  modelPathOf,
  parseLock,
  parseUserProfiles,
  selectBuild,
  selectProfile,
  type ModelLock,
  type ModelProfile,
  withUserProfiles,
} from "./lock.ts"
import {
  baseUrl,
  checkJsonSchema,
  checkProps,
  checkRenderedPrompt,
  serverArgs,
  waitHealthy,
  type Fetch,
} from "./server.ts"
import { hasPass, withPass } from "./verified.ts"
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
  download: FetchDeps["download"]
  sleep: (ms: number) => Promise<void>
  /** Calls the handler on SIGTERM or SIGINT. */
  onStopSignal: (handler: () => void) => void
  fs: FetchDeps["fs"] & {
    writeFile: (path: string, text: string) => void
  }
  /** The stack settings store (`stack.env`), shared with `pnpm stack:setup`. */
  settings: SettingsFiles
  env: Env
  home: string
  platform: Platform
  /** The user id launchd's gui domain is named by; undefined where there is none (Windows). */
  uid: number | undefined
  /** Absolute paths of node and of `infra/llama/bin.ts`, for the LaunchAgent. */
  node: string
  launcher: string
  /** `infra/model.lock` in this checkout. */
  defaultLockPath: string
  /** Where the reference prompts live: `<fixtureDir>/<model file name>.prompt.txt`. */
  fixtureDir: string
  out: (line: string) => void
  err: (line: string) => void
}

/** How long launch waits for /health after starting llama-server (cold load from disk). */
export const READY_TIMEOUT_MS = 180_000

const USAGE =
  "usage: llama verify|verify-archive PATH|fetch [--model ID]|list|add REPO FILE [--revision SHA] [--id ID] [--marker TEXT] [--kwargs JSON]|use ID|launch|check-template [--model ID]|plan|install|uninstall|status"

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

export type Base = { lock: ModelLock; config: LlamaConfig }

type Loaded = Base & { profile: ModelProfile; modelPath: string }

/** model.lock, plus the user's own profiles when that file exists. */
export function loadBase(deps: Deps): Base {
  const lockPath = lockPathFrom(deps.env, deps.defaultLockPath)
  const lock = parseLock(deps.readText(lockPath))
  const config = buildConfig(
    deps.env,
    deps.home,
    deps.defaultLockPath,
    lock,
    deps.platform
  )
  if (!deps.fs.exists(config.profilesPath)) return { lock, config }
  const user = parseUserProfiles(
    deps.readText(config.profilesPath),
    config.profilesPath
  )
  return { lock: withUserProfiles(lock, user, config.profilesPath), config }
}

/** Verified in model.lock, or passed check-template on this machine with this file and build. */
function isVerified(deps: Deps, { lock, config }: Base, profile: ModelProfile) {
  if (profile.verified) return true
  return (
    deps.fs.exists(config.verifiedPath) &&
    hasPass(deps.readText(config.verifiedPath), profile, lock.llamaCppBuild)
  )
}

const unverified = (base: Base, profile: ModelProfile): string =>
  `FAIL: profile ${profile.id} has not passed llama check-template with llama.cpp ${base.lock.llamaCppBuild} on this machine; run llama check-template --model ${profile.id}`

/** The tracking issue for running llama-server as a service outside macOS. */
const SERVICE_ISSUE = "#629"

/** launchd's user id on macOS; undefined (after saying why) on any other platform. */
function launchdUid(deps: Deps, command: string): number | undefined {
  if (deps.platform.os === "darwin" && deps.uid !== undefined) return deps.uid
  deps.err(
    `FAIL: llama ${command} needs launchd and is not supported on this platform yet (${SERVICE_ISSUE})`
  )
  return undefined
}

/** The active profile id: EIDO_LLAMA_MODEL from the environment, else the settings file, else the lock's default. */
/** The key in `stack.env` holding the active profile id. An exported variable wins over it. */
const MODEL_KEY = "EIDO_LLAMA_MODEL"

const settingsPathOf = (deps: Deps): string =>
  stackSettingsPath(deps.env, deps.home, platformOf(deps.platform.os))

function activeId(deps: Deps, { lock }: Base): string {
  const fromEnv = envValue(deps.env, MODEL_KEY)
  if (fromEnv !== undefined) return fromEnv
  const fromFile = getStackSetting(
    deps.settings,
    settingsPathOf(deps),
    MODEL_KEY,
    platformOf(deps.platform.os)
  )
  return fromFile === undefined || fromFile === ""
    ? lock.defaultProfile
    : fromFile
}

function withProfile(base: Base, profile: ModelProfile): Loaded {
  return {
    ...base,
    profile,
    modelPath: modelPathOf(profile, base.config.modelDir, base.config.join),
  }
}

/** Build first (fast), then the model hash. Logs both digests on a mismatch. */
async function verify(
  deps: Deps,
  { lock, config, profile, modelPath }: Loaded
): Promise<boolean> {
  deps.out(
    `pin: profile ${profile.id}, ${profile.model} ${profile.quantization} (${modelPath}), llama.cpp ${lock.llamaCppBuild}`
  )
  const build = await verifyBuild(config.binary, lock, deps.run)
  if (!build.ok) {
    deps.err(`FAIL: ${build.message}`)
    return false
  }
  deps.out(
    `ok: ${config.binary} is ${lock.llamaCppBuild} (${lock.llamaCppCommit})`
  )
  const model = await verifyModel(modelPath, profile, deps.probe)
  if (!model.ok) {
    deps.err(`FAIL: ${model.message}`)
    return false
  }
  deps.out(
    `ok: ${modelPath} sha256 ${model.sha256} (hashed in ${seconds(model.hashMs)})`
  )
  return true
}

/** The last part of a path on the configured platform, so a Windows path splits on a backslash. */
const fileName = (config: LlamaConfig, path: string): string =>
  (config.windows ? win32 : posix).basename(path)

async function verifyArchive(
  deps: Deps,
  { lock, config }: Base,
  path: string | undefined
): Promise<number> {
  if (path === undefined) {
    deps.err(USAGE)
    return 2
  }
  const asset = selectBuild(lock, config.platform)
  if (fileName(config, path) !== asset.asset) {
    deps.err(`FAIL: ${path} is not ${asset.asset}`)
    return 1
  }
  if ((await deps.probe.size(path)) === undefined) {
    deps.err(`FAIL: no file at ${path}`)
    return 1
  }
  const actual = await deps.probe.sha256(path)
  if (actual !== asset.sha256) {
    deps.err(
      `FAIL: ${path}: sha256 mismatch: expected ${asset.sha256}, actual ${actual}`
    )
    return 1
  }
  deps.out(`ok: ${path} sha256 ${actual}`)
  return 0
}

type Serving = { child: ServerProcess; ms: number; stopping: () => boolean }

/**
 * Verifies, starts llama-server for the profile and waits for /health. Returns the exit code
 * instead when it does not get there: 1 on a failure, 0 when a stop signal came first.
 */
async function serve(deps: Deps, loaded: Loaded): Promise<Serving | number> {
  if (!(await verify(deps, loaded))) {
    deps.err("llama-server was not started")
    return 1
  }
  const { config, profile } = loaded
  const args = serverArgs(loaded.modelPath, config.port, profile)
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
  return { child, ms: ready.ms, stopping: () => stopping }
}

const markerText = (profile: ModelProfile): string =>
  profile.chatTemplateMarker === undefined
    ? "chat template loaded"
    : `chat template has ${profile.chatTemplateMarker}`

async function launch(deps: Deps, loaded: Loaded): Promise<number> {
  const { config, profile } = loaded
  if (!isVerified(deps, loaded, profile)) {
    deps.err(unverified(loaded, profile))
    deps.err("llama-server was not started")
    return 1
  }
  const started = await serve(deps, loaded)
  if (typeof started === "number") return started
  const { child, ms, stopping } = started
  const props = await checkProps(
    config.port,
    profile.chatTemplateMarker,
    deps.fetch
  )
  if (!props.ok) {
    deps.err(`FAIL: ${props.message}`)
    child.kill("SIGTERM")
    await child.exited
    return 1
  }
  deps.out(
    `ok: llama-server ready on ${baseUrl(config.port)} in ${seconds(ms)}; profile ${profile.id}, ${markerText(profile)}`
  )
  const code = await child.exited
  if (stopping()) return 0
  deps.err(`llama-server exited with code ${code}`)
  return code === 0 ? 1 : code
}

/** Whether anything answers HTTP on the port. */
async function answers(deps: Deps, port: number): Promise<boolean> {
  try {
    await deps.fetch(`${baseUrl(port)}/health`)
    return true
  } catch {
    return false
  }
}

async function templateChecks(
  deps: Deps,
  { lock, config, profile, modelPath }: Loaded
): Promise<number> {
  const file = fileName(config, modelPath)
  const referencePath = join(deps.fixtureDir, `${file}.prompt.txt`)
  const reference = deps.fs.exists(referencePath)
    ? deps.readText(referencePath)
    : undefined
  if (reference === undefined)
    deps.out(
      `note: no reference prompt at ${referencePath}; the rendered prompt is not compared`
    )
  const checks = [
    [
      "chat template",
      await checkProps(config.port, profile.chatTemplateMarker, deps.fetch),
    ],
    ...(reference === undefined
      ? []
      : ([
          [
            "rendered prompt",
            await checkRenderedPrompt(config.port, reference, deps.fetch),
          ],
        ] as const)),
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
  if (code !== 0) return code
  deps.out(`ok: template check passed on ${lock.llamaCppBuild} with ${file}`)
  const record = deps.fs.exists(config.verifiedPath)
    ? deps.readText(config.verifiedPath)
    : ""
  deps.fs.mkdir(config.stackDir)
  deps.fs.writeFile(
    config.verifiedPath,
    withPass(record, profile, lock.llamaCppBuild)
  )
  deps.out(`ok: recorded the pass for ${profile.id} in ${config.verifiedPath}`)
  return 0
}

async function checkTemplate(
  deps: Deps,
  base: Base,
  args: readonly string[]
): Promise<number> {
  const model = option(args, "--model")
  if (!model.ok) {
    deps.err(USAGE)
    return 2
  }
  if (model.value === undefined) {
    const loaded = withProfile(
      base,
      selectProfile(base.lock, activeId(deps, base))
    )
    if (!isVerified(deps, base, loaded.profile)) {
      deps.err(
        `FAIL: profile ${loaded.profile.id} is not verified, so launch does not run it; run llama check-template --model ${loaded.profile.id}`
      )
      return 1
    }
    return templateChecks(deps, loaded)
  }
  const loaded = withProfile(base, selectProfile(base.lock, model.value))
  const { port } = base.config
  if (await answers(deps, port)) {
    deps.err(
      `FAIL: a server already answers on ${baseUrl(port)}; stop it so check-template can start ${loaded.profile.id} there`
    )
    return 1
  }
  const started = await serve(deps, loaded)
  if (typeof started === "number") return 1
  try {
    return await templateChecks(deps, loaded)
  } finally {
    started.child.kill("SIGTERM")
    await started.child.exited
  }
}

function plist(deps: Deps, config: LlamaConfig): string {
  return buildPlist({
    home: deps.home,
    node: deps.node,
    launcher: deps.launcher,
    env: launchEnv(config),
  })
}

async function install(
  deps: Deps,
  uid: number,
  loaded: Loaded
): Promise<number> {
  const { config, modelPath, profile } = loaded
  // launchd would restart a launcher that refuses the profile, over and over.
  if (!isVerified(deps, loaded, profile)) {
    deps.err(unverified(loaded, profile))
    return 1
  }
  for (const [what, path] of [
    ["llama-server", config.binary],
    ["model file", modelPath],
  ] as const) {
    if (!deps.fs.exists(path)) {
      deps.err(`FAIL: no ${what} at ${path}; see infra/llama-server.md`)
      return 1
    }
  }
  const paths = layout(deps.home)
  // bootstrap refuses a label that is already loaded, so a re-install boots the old job out first.
  if ((await deps.run("launchctl", printArgs(uid))).code === 0)
    await deps.run("launchctl", bootoutArgs(uid))
  deps.fs.mkdir(paths.logDir)
  deps.fs.writeFile(paths.plistPath, plist(deps, config))
  const run = await deps.run("launchctl", bootstrapArgs(uid, paths.plistPath))
  if (run.code !== 0) {
    deps.err(`FAIL: launchctl bootstrap: ${run.stderr.trim() || run.code}`)
    return 1
  }
  deps.out(`ok: ${target(uid)} loaded from ${paths.plistPath}`)
  deps.out(`logs: ${paths.outLog} and ${paths.errLog}`)
  return 0
}

async function uninstall(deps: Deps, uid: number): Promise<number> {
  const paths = layout(deps.home)
  if ((await deps.run("launchctl", printArgs(uid))).code === 0) {
    const run = await deps.run("launchctl", bootoutArgs(uid))
    if (run.code !== 0) {
      deps.err(`FAIL: launchctl bootout: ${run.stderr.trim() || run.code}`)
      return 1
    }
  }
  if (deps.fs.exists(paths.plistPath)) deps.fs.remove(paths.plistPath)
  deps.out(`ok: ${target(uid)} is not loaded and its plist is gone`)
  return 0
}

async function status(
  deps: Deps,
  uid: number,
  { config }: Loaded
): Promise<number> {
  let code = 0
  const printed = await deps.run("launchctl", printArgs(uid))
  if (printed.code === 0) {
    const job = parsePrint(printed.stdout)
    deps.out(
      `launchd: ${target(uid)} state ${job.state ?? "unknown"}, pid ${job.pid ?? "none"}, runs ${job.runs ?? "unknown"}, last exit ${job.lastExit ?? "none"}`
    )
  } else deps.out(`launchd: ${target(uid)} is not loaded`)

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

function option(
  args: readonly string[],
  name: string
): { ok: true; value: string | undefined } | { ok: false } {
  if (args.length === 0) return { ok: true, value: undefined }
  if (args.length === 2 && args[0] === name) return { ok: true, value: args[1] }
  return { ok: false }
}

async function fetchCommand(
  deps: Deps,
  base: Base,
  args: readonly string[]
): Promise<number> {
  const model = option(args, "--model")
  if (!model.ok) {
    deps.err(USAGE)
    return 2
  }
  const profile = selectProfile(base.lock, model.value ?? activeId(deps, base))
  deps.out(`profile ${profile.id}: ${profile.model} ${profile.quantization}`)
  if (!(await fetchBuild(deps, base.lock, base.config))) return 1
  if (!(await fetchModel(deps, profile, base.config))) return 1
  deps.out(
    `ok: ${base.lock.llamaCppBuild} and profile ${profile.id} are installed`
  )
  return 0
}

export type DiskState =
  | { kind: "present" }
  | { kind: "missing" }
  | { kind: "wrong_size"; bytes: number }

/** Present when a file of the pinned size is there; the hash is checked by verify and launch. */
async function diskOf(
  deps: Pick<Deps, "probe">,
  path: string,
  size: number
): Promise<DiskState> {
  const actual = await deps.probe.size(path)
  if (actual === undefined) return { kind: "missing" }
  return actual === size
    ? { kind: "present" }
    : { kind: "wrong_size", bytes: actual }
}

function describeDisk(disk: DiskState): string {
  switch (disk.kind) {
    case "present":
      return "on disk"
    case "missing":
      return "not on disk"
    case "wrong_size":
      return `wrong size (${disk.bytes} bytes)`
  }
}

export type ProfileRow = {
  profile: ModelProfile
  disk: DiskState
  verified: boolean
  isDefault: boolean
}

/** Every profile with its file's state on disk and whether it is verified here, and the active id. */
export async function profileRows(
  deps: Deps,
  base: Base
): Promise<{ active: string; rows: ProfileRow[] }> {
  const rows: ProfileRow[] = []
  for (const profile of base.lock.profiles)
    rows.push({
      profile,
      disk: await diskOf(
        deps,
        modelPathOf(profile, base.config.modelDir, base.config.join),
        profile.size
      ),
      verified: isVerified(deps, base, profile),
      isDefault: profile.id === base.lock.defaultProfile,
    })
  return { active: activeId(deps, base), rows }
}

async function list(deps: Deps, base: Base): Promise<number> {
  const { active, rows } = await profileRows(deps, base)
  for (const { profile, disk, verified, isDefault } of rows) {
    const notes = [
      describeDisk(disk),
      verified ? "verified" : "unverified",
      ...(profile.origin === "user" ? ["added"] : []),
      ...(isDefault ? ["default"] : []),
      ...(profile.id === active ? ["active"] : []),
    ]
    deps.out(
      `${profile.id === active ? "*" : " "} ${profile.id}: ${profile.model} ${profile.quantization}, ${notes.join(", ")}`
    )
  }
  if (!rows.some((row) => row.profile.id === active)) {
    deps.err(
      `FAIL: the active profile ${JSON.stringify(active)} is not in model.lock; run llama use with one of the ids above`
    )
    return 1
  }
  return 0
}

async function use(
  deps: Deps,
  base: Base,
  id: string | undefined
): Promise<number> {
  if (id === undefined) {
    deps.err(USAGE)
    return 2
  }
  const profile = selectProfile(base.lock, id)
  const path = modelPathOf(profile, base.config.modelDir, base.config.join)
  const disk = await diskOf(deps, path, profile.size)
  if (disk.kind !== "present") {
    deps.err(
      `FAIL: ${path} is ${describeDisk(disk)}; run llama fetch --model ${profile.id} first`
    )
    return 1
  }
  if (!isVerified(deps, base, profile)) {
    deps.err(unverified(base, profile))
    return 1
  }
  const settingsPath = settingsPathOf(deps)
  writeStackSetting(
    deps.settings,
    settingsPath,
    MODEL_KEY,
    profile.id,
    platformOf(deps.platform.os)
  )
  deps.out(`ok: ${MODEL_KEY}=${profile.id} in ${settingsPath}`)
  const exported = envValue(deps.env, MODEL_KEY)
  if (exported !== undefined && exported !== profile.id)
    deps.out(
      `note: ${MODEL_KEY}=${exported} is exported in this shell and wins over the file here`
    )

  const uid = deps.platform.os === "darwin" ? deps.uid : undefined
  if (uid === undefined) {
    deps.out(
      `no LaunchAgent on this platform (${SERVICE_ISSUE}); stop and rerun llama launch to load ${profile.id}`
    )
    return 0
  }
  if ((await deps.run("launchctl", printArgs(uid))).code !== 0) {
    deps.out(`${target(uid)} is not installed; nothing to restart`)
    return 0
  }
  const run = await deps.run("launchctl", kickstartArgs(uid))
  if (run.code !== 0) {
    deps.err(`FAIL: launchctl kickstart: ${run.stderr.trim() || run.code}`)
    return 1
  }
  deps.out(`ok: restarted ${target(uid)}; it verifies and loads ${profile.id}`)
  return 0
}

/** `--name value` pairs after the positional arguments; undefined on an unknown or repeated flag. */
function flagValues(
  args: readonly string[],
  names: readonly string[]
): Map<string, string> | undefined {
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i] ?? ""
    const value = args[i + 1]
    if (!names.includes(name) || value === undefined || values.has(name))
      return undefined
    values.set(name, value)
  }
  return values
}

async function add(
  deps: Deps,
  base: Base,
  args: readonly string[]
): Promise<number> {
  const [repo, path, ...rest] = args
  const flags = flagValues(rest, ["--revision", "--id", "--marker", "--kwargs"])
  if (repo === undefined || path === undefined || flags === undefined) {
    deps.err(USAGE)
    return 2
  }
  const file = await hubFile(deps.fetch, repo, path, flags.get("--revision"))
  const section = profileSection(file, {
    id: flags.get("--id"),
    marker: flags.get("--marker"),
    kwargs: flags.get("--kwargs"),
  })
  const { profilesPath, stackDir } = base.config
  const before = deps.fs.exists(profilesPath) ? deps.readText(profilesPath) : ""
  const text =
    before === "" ? section : `${before.replace(/\n*$/, "\n\n")}${section}`
  // Parse the whole file first, so a bad flag or a clash with model.lock writes nothing.
  const profiles = parseUserProfiles(text, profilesPath)
  const added = profiles.at(-1)
  if (added === undefined) throw new Error(`${profilesPath} gained no profile`)
  const lock = {
    ...base.lock,
    profiles: base.lock.profiles.filter((p) => p.origin === "lock"),
  }
  withUserProfiles(lock, profiles, profilesPath)
  deps.fs.mkdir(stackDir)
  deps.fs.writeFile(profilesPath, text)
  deps.out(
    `ok: added profile ${added.id} (${file.repo} ${file.path} at ${file.revision}, ${file.size} bytes, sha256 ${file.sha256}) to ${profilesPath}`
  )
  deps.out("next:")
  deps.out(`  llama fetch --model ${added.id}`)
  deps.out(`  llama check-template --model ${added.id}`)
  deps.out("  then run the model eval (#28) before relying on it")
  return 0
}

export async function main(
  argv: readonly string[],
  deps: Deps
): Promise<number> {
  const [command, ...rest] = argv
  try {
    return await run(command, rest, deps)
  } catch (error) {
    deps.err(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function run(
  command: string | undefined,
  rest: readonly string[],
  deps: Deps
): Promise<number> {
  switch (command) {
    case "uninstall": {
      const uid = launchdUid(deps, command)
      return uid === undefined ? 1 : uninstall(deps, uid)
    }
    case "verify-archive":
      return verifyArchive(deps, loadBase(deps), rest[0])
    case "fetch":
      return fetchCommand(deps, loadBase(deps), rest)
    case "list":
      return list(deps, loadBase(deps))
    case "use":
      return use(deps, loadBase(deps), rest[0])
    case "add":
      return add(deps, loadBase(deps), rest)
    case "check-template":
      return checkTemplate(deps, loadBase(deps), rest)
    case "verify":
    case "launch":
    case "plan":
    case "install":
    case "status":
      break
    default:
      deps.err(USAGE)
      return 2
  }
  const base = loadBase(deps)
  const loaded = withProfile(
    base,
    selectProfile(base.lock, activeId(deps, base))
  )
  switch (command) {
    case "verify":
      return (await verify(deps, loaded)) ? 0 : 1
    case "launch":
      return launch(deps, loaded)
  }
  const uid = launchdUid(deps, command)
  if (uid === undefined) return 1
  switch (command) {
    case "plan":
      deps.out(`# ${layout(deps.home).plistPath}`)
      deps.out(plist(deps, loaded.config))
      deps.out(
        `launchctl ${bootstrapArgs(uid, layout(deps.home).plistPath).join(" ")}`
      )
      return 0
    case "install":
      return install(deps, uid, loaded)
    case "status":
      return status(deps, uid, loaded)
  }
}
