// The stack's preflight checks (#625), as a library: `pnpm stack:doctor` prints them, start runs
// the blocking ones first, and a setup UI can call `runDoctor` itself. Every check is read-only
// and returns ok, warn or fail with a fix: a machine-readable action and the command to run.
// Each check names the platforms it runs on; the Mac pieces (the Keychain, launchd) are additions
// to a base that also runs on Windows and Linux.
// apps/web/.env.local is read for key names; only APP_BASE_URL's value is compared, never shown.
import { parseEnv } from "node:util"

import { buildConfig, lockPathFrom } from "../llama/config.ts"
import { parseLock, type ModelLock } from "../llama/lock.ts"
import { serverArgs } from "../llama/server.ts"
import { verifyBuild, verifyModel } from "../llama/verify.ts"
import type { Fetch } from "../tailscale/measure.ts"
import { parseDnsName } from "../tailscale/serve-routes.ts"
import {
  buildStackConfig,
  pathsFor,
  pidFilePath,
  stackDirOf,
  type Env,
  type Platform,
  type StackConfig,
} from "./config.ts"
import { describeListeners, listenersOn, type Exec } from "./ports.ts"
import type { FileStat } from "./settings.ts"
import { parsePidRecord } from "./supervise.ts"

export type CheckId =
  | "node"
  | "dependencies"
  | "settings"
  | "tailscale"
  | "stack-config"
  | "web-env"
  | "keychain"
  | "vault"
  | "push"
  | "llama-pin"
  | "llama-health"
  | "gmail"
  | "ports"

export type FixAction =
  | "install-node"
  | "install-dependencies"
  | "start-tailscale"
  | "connect-tailscale"
  | "enable-magicdns"
  | "create-web-env"
  | "add-web-env-keys"
  | "add-base-url"
  | "fix-settings"
  | "run-setup"
  | "use-keychain-file"
  | "chmod-keychain"
  | "unlock-keychain"
  | "install-llama-build"
  | "download-model"
  | "start-llama"
  | "free-port"

export type Fix = { action: FixAction; text: string }

export type CheckStatus = "ok" | "warn" | "fail"

export type Check = {
  id: CheckId
  /** The platforms this check runs on. */
  platforms: readonly Platform[]
  status: CheckStatus
  summary: string
  /** How to clear a warn or fail. A warn about work not built yet has none. */
  fix?: Fix
}

export type DoctorFiles = {
  exists: (path: string) => boolean
  read: (path: string) => string | undefined
  stat: (path: string) => FileStat | undefined
}

export type DoctorDeps = {
  platform: Platform
  /** The environment with stack.env applied. */
  env: Env
  home: string
  repoRoot: string
  /** `process.version`, for example `v24.3.0`. */
  nodeVersion: string
  exec: Exec
  fetch: Fetch
  files: DoctorFiles
  sha256: (path: string) => Promise<string>
  now: () => number
}

export type DoctorOptions = {
  /** Check the tailnet: Tailscale itself and APP_BASE_URL. False for `--no-serve`. */
  serve: boolean
  /** Check the model's size but skip its hash, which takes seconds. */
  quick: boolean
}

const ALL: readonly Platform[] = ["darwin", "win32", "linux"]
const MAC: readonly Platform[] = ["darwin"]
const NOT_MAC: readonly Platform[] = ["win32", "linux"]
const WINDOWS: readonly Platform[] = ["win32"]

/** The keychain setup creates on macOS when EIDO_GATE_KEYCHAIN_PATH is not set. */
export const defaultKeychainPath = (home: string): string =>
  pathsFor("darwin").join(
    home,
    "Library",
    "Keychains",
    "eido",
    "eido.keychain-db"
  )

/** The development file vault setup points the gate at on Windows and Linux (#455). */
export const defaultVaultFile = (
  platform: Platform,
  env: Env,
  home: string
): string =>
  pathsFor(platform).join(stackDirOf(platform, env, home), "gate", "vault.json")

/** The keys apps/web reads from .env.local at start (docs/auth0-setup.md). */
export const WEB_ENV_KEYS = [
  "AUTH0_DOMAIN",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET",
  "APP_BASE_URL",
  "EIDO_OWNER_EMAIL",
] as const

/** `text` quoted for the platform's shell: POSIX single quotes, or double quotes on Windows. */
export const quote = (text: string, platform: Platform = "darwin"): string =>
  platform === "win32"
    ? `"${text.replaceAll('"', '""')}"`
    : `'${text.replaceAll("'", `'\\''`)}'`

type Make = (
  id: CheckId,
  summary: string,
  fix?: Fix,
  platforms?: readonly Platform[]
) => Check
const make =
  (status: CheckStatus): Make =>
  (id, summary, fix, platforms = ALL) => ({
    id,
    platforms,
    status,
    summary,
    ...(fix === undefined ? {} : { fix }),
  })
const ok = make("ok")
const warn = make("warn")
const fail = make("fail")
const fix = (action: FixAction, text: string): Fix => ({ action, text })

const set = (env: Env, key: string): string | undefined => {
  const value = env[key]
  return value === undefined || value === "" ? undefined : value
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "")
  } catch {
    return undefined
  }
}

/** Whether `version` (v24.3.0) meets an engines range of the form `>=24`, `>=24.1` or `>=24.1.2`. */
export function meetsEngines(
  version: string,
  range: string
): boolean | undefined {
  const wanted = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim())
  const actual = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (wanted === null || actual === null) return undefined
  for (let i = 1; i <= 3; i++) {
    const a = Number(actual[i])
    const w = Number(wanted[i] ?? 0)
    if (a !== w) return a > w
  }
  return true
}

const INSTALL_NODE: Record<Platform, string> = {
  darwin: "brew install node",
  win32: "winget install OpenJS.NodeJS",
  linux: "install Node from https://nodejs.org/en/download",
}

function checkNode(deps: DoctorDeps): Check {
  const join = (...parts: string[]) => pathsFor(deps.platform).join(...parts)
  const range = field(
    field(
      parseJson(deps.files.read(join(deps.repoRoot, "package.json"))),
      "engines"
    ),
    "node"
  )
  if (typeof range !== "string")
    return fail(
      "node",
      "package.json has no engines.node range",
      fix("install-dependencies", "git checkout package.json")
    )
  const meets = meetsEngines(deps.nodeVersion, range)
  if (meets === true) return ok("node", `node ${deps.nodeVersion} (${range})`)
  return fail(
    "node",
    meets === undefined
      ? `cannot compare node ${deps.nodeVersion} with engines ${range}`
      : `node ${deps.nodeVersion} does not meet engines ${range}`,
    fix("install-node", INSTALL_NODE[deps.platform])
  )
}

function checkDependencies(deps: DoctorDeps): Check {
  const join = (...parts: string[]) => pathsFor(deps.platform).join(...parts)
  return deps.files.exists(join(deps.repoRoot, "node_modules", ".modules.yaml"))
    ? ok("dependencies", "node_modules is installed")
    : fail(
        "dependencies",
        "node_modules is not installed",
        fix("install-dependencies", "pnpm install --frozen-lockfile")
      )
}

/** Windows has no mode bits; stack.env's ACL check belongs to #455, so it is reported, not faked. */
function checkSettingsAccess(): Check {
  return warn(
    "settings",
    "stack.env permissions are not checked on Windows; the ACL check is part of #455",
    undefined,
    WINDOWS
  )
}

const START_TAILSCALE: Record<Platform, string> = {
  darwin: "open -a Tailscale",
  win32: "Start-Service Tailscale",
  linux: "sudo systemctl start tailscaled",
}

async function checkTailscale(
  deps: DoctorDeps
): Promise<{ check: Check; host?: string }> {
  const run = await deps.exec("tailscale", ["status", "--json"])
  if (run.code !== 0)
    return {
      check: fail(
        "tailscale",
        `tailscale status failed: ${run.stderr.trim() || `exit ${run.code}`}`,
        fix("start-tailscale", START_TAILSCALE[deps.platform])
      ),
    }
  const state = field(parseJson(run.stdout), "BackendState")
  if (state !== "Running")
    return {
      check: fail(
        "tailscale",
        `Tailscale is not connected (${typeof state === "string" ? state : "unknown state"})`,
        fix("connect-tailscale", "tailscale up")
      ),
    }
  try {
    const host = parseDnsName(run.stdout)
    return { check: ok("tailscale", `running, MagicDNS host ${host}`), host }
  } catch (error) {
    return {
      check: fail(
        "tailscale",
        (error as Error).message,
        fix("enable-magicdns", "tailscale set --accept-dns=true")
      ),
    }
  }
}

function checkWebEnv(deps: DoctorDeps, edgeOrigin: string | undefined): Check {
  const join = (...parts: string[]) => pathsFor(deps.platform).join(...parts)
  const relative = join("apps", "web", ".env.local")
  const text = deps.files.read(join(deps.repoRoot, relative))
  if (text === undefined)
    return fail(
      "web-env",
      `${relative} is missing`,
      fix(
        "create-web-env",
        `${deps.platform === "win32" ? "copy" : "cp"} ${join("apps", "web", ".env.example")} ${relative}`
      )
    )
  // Only key names leave this function, and whether APP_BASE_URL lists the edge origin.
  const values = parseEnv(text)
  const missing = WEB_ENV_KEYS.filter((key) => (values[key] ?? "") === "")
  if (missing.length > 0)
    return fail(
      "web-env",
      `${relative} has no value for ${missing.join(", ")}`,
      fix(
        "add-web-env-keys",
        `set ${missing.join(", ")} in ${relative} (docs/auth0-setup.md)`
      )
    )
  if (edgeOrigin === undefined)
    return ok("web-env", `${relative} has the Auth0 keys`)
  const listed = (values["APP_BASE_URL"] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/$/, ""))
  if (!listed.includes(edgeOrigin))
    return fail(
      "web-env",
      `APP_BASE_URL in ${relative} does not include ${edgeOrigin}`,
      fix("add-base-url", `add ${edgeOrigin} to APP_BASE_URL in ${relative}`)
    )
  return ok("web-env", `${relative} has the Auth0 keys and ${edgeOrigin}`)
}

async function checkKeychain(deps: DoctorDeps): Promise<Check> {
  const check = (status: Make, summary: string, f?: Fix) =>
    status("keychain", summary, f, MAC)
  const path = set(deps.env, "EIDO_GATE_KEYCHAIN_PATH")
  if (path === undefined)
    return check(
      fail,
      "EIDO_GATE_KEYCHAIN_PATH is not set",
      fix("run-setup", "pnpm stack:setup")
    )
  const stat = deps.files.stat(path)
  if (stat === undefined)
    return check(
      fail,
      `no keychain at ${path}`,
      fix("run-setup", "pnpm stack:setup")
    )
  if (!stat.isFile)
    return check(
      fail,
      `${path} is not a regular file`,
      fix(
        "use-keychain-file",
        "set EIDO_GATE_KEYCHAIN_PATH to the keychain file itself: pnpm stack:setup"
      )
    )
  const mode = stat.mode & 0o777
  if (mode !== 0o600)
    return check(
      fail,
      `${path} has mode ${mode.toString(8).padStart(4, "0")}, not 0600`,
      fix("chmod-keychain", `chmod 600 ${quote(path)}`)
    )
  const info = await deps.exec("security", ["show-keychain-info", path])
  if (info.code !== 0)
    return check(
      fail,
      `${path} is locked or unreadable`,
      fix("unlock-keychain", `security unlock-keychain ${quote(path)}`)
    )
  return check(ok, `${path} is unlocked, mode 0600`)
}

/** Off macOS the gate has only the development file vault; a production vault is #455. */
function checkVault(deps: DoctorDeps): Check {
  const file = set(deps.env, "EIDO_GATE_VAULT_FILE")
  if (deps.env["EIDO_DEV_VAULT"] === "1" && file !== undefined)
    return warn(
      "vault",
      `development file vault at ${file}; a production vault on this platform is not built yet (#455)`,
      undefined,
      NOT_MAC
    )
  return fail(
    "vault",
    "no gate vault: set EIDO_DEV_VAULT=1 with EIDO_GATE_VAULT_FILE",
    fix("run-setup", "pnpm stack:setup"),
    NOT_MAC
  )
}

function checkPush(deps: DoctorDeps): Check {
  const subject = set(deps.env, "EIDO_PUSH_VAPID_SUBJECT")
  return subject === undefined
    ? warn(
        "push",
        "EIDO_PUSH_VAPID_SUBJECT is not set, so push stays off",
        fix("run-setup", "pnpm stack:setup")
      )
    : ok("push", `Web Push subject ${subject}`)
}

function checkGmail(deps: DoctorDeps): Check {
  const missing = ["EIDO_GMAIL_CLIENT_ID", "EIDO_GMAIL_READ_CLIENT_ID"].filter(
    (key) => set(deps.env, key) === undefined
  )
  return missing.length === 0
    ? ok("gmail", "both Gmail client ids are set")
    : warn(
        "gmail",
        `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set, so Gmail cannot connect`,
        fix("run-setup", "pnpm stack:setup")
      )
}

type LlamaPaths = { binary: string; modelPath: string; port: number }

/**
 * infra/llama's defaults are the Mac layout. Elsewhere the binary and model sit under the
 * platform's stack dir, and the binary is llama-server.exe on Windows; the env overrides win.
 */
function llamaPaths(
  deps: DoctorDeps,
  lock: ModelLock,
  lockPath: string
): LlamaPaths {
  const config = buildConfig(deps.env, deps.home, lockPath, lock)
  if (deps.platform === "darwin") return config
  const join = (...parts: string[]) => pathsFor(deps.platform).join(...parts)
  const root = stackDirOf(deps.platform, deps.env, deps.home)
  const modelDir = set(deps.env, "EIDO_MODEL_DIR") ?? join(root, "models")
  return {
    port: config.port,
    modelPath: join(modelDir, lock.file),
    binary:
      set(deps.env, "EIDO_LLAMA_SERVER_BIN") ??
      join(
        root,
        "llama.cpp",
        lock.llamaCppBuild,
        deps.platform === "win32" ? "llama-server.exe" : "llama-server"
      ),
  }
}

async function checkLlama(deps: DoctorDeps, quick: boolean): Promise<Check[]> {
  const join = (...parts: string[]) => pathsFor(deps.platform).join(...parts)
  const defaultLock = join(deps.repoRoot, "infra", "model.lock")
  let lock: ModelLock
  let paths: LlamaPaths
  try {
    lock = parseLock(deps.files.read(lockPathFrom(deps.env, defaultLock)) ?? "")
    paths = llamaPaths(deps, lock, defaultLock)
  } catch (error) {
    return [
      fail(
        "llama-pin",
        (error as Error).message,
        fix("fix-settings", "git checkout infra/model.lock")
      ),
    ]
  }
  const q = (text: string) => quote(text, deps.platform)
  const download = fix(
    "download-model",
    `${deps.platform === "win32" ? "curl.exe" : "curl"} -L --fail -o ${q(paths.modelPath)} ${q(lock.source)}`
  )
  const checks: Check[] = []
  const build = await verifyBuild(paths.binary, lock, deps.exec)
  const modelStat = deps.files.stat(paths.modelPath)
  if (!build.ok)
    checks.push(
      fail(
        "llama-pin",
        build.message,
        fix(
          "install-llama-build",
          `install llama.cpp ${lock.llamaCppBuild} at ${paths.binary}: infra/llama-server.md, "Install the pinned build and model"`
        )
      )
    )
  else if (modelStat === undefined || !modelStat.isFile)
    checks.push(
      fail("llama-pin", `no model file at ${paths.modelPath}`, download)
    )
  else {
    const model = quick
      ? modelStat.size === lock.size
        ? { ok: true as const }
        : {
            ok: false as const,
            message: `${paths.modelPath}: size mismatch: expected ${lock.size} bytes, actual ${modelStat.size}`,
          }
      : await verifyModel(paths.modelPath, lock, {
          size: (path) => Promise.resolve(deps.files.stat(path)?.size),
          sha256: deps.sha256,
          now: deps.now,
        })
    checks.push(
      model.ok
        ? ok(
            "llama-pin",
            `${lock.llamaCppBuild} and ${lock.file} match the pin${quick ? " (size only)" : ""}`
          )
        : fail("llama-pin", model.message, download)
    )
  }
  const health = `http://127.0.0.1:${paths.port}/health`
  let status: number | undefined
  try {
    status = (await deps.fetch(health)).status
  } catch {
    status = undefined
  }
  // The launchd job is macOS only; elsewhere the fix is the server command itself.
  const start =
    deps.platform === "darwin"
      ? "pnpm --filter @eido/infra llama install"
      : [paths.binary, ...serverArgs(paths.modelPath, paths.port)]
          .map((arg) => (/^[\w.:/-]+$/.test(arg) ? arg : q(arg)))
          .join(" ")
  checks.push(
    status === 200
      ? ok("llama-health", `${health} answers 200`)
      : fail(
          "llama-health",
          `${health} ${status === undefined ? "does not answer" : `answers ${status}`}`,
          fix("start-llama", start)
        )
  )
  return checks
}

const PORT_VARIABLES = {
  gate: "EIDO_GATE_PHONE_PORT",
  core: "EIDO_CORE_PORT",
  web: "EIDO_WEB_PORT",
} as const

/** The process group a pid belongs to (POSIX). */
async function groupOf(exec: Exec, pid: number): Promise<number | undefined> {
  const run = await exec("ps", ["-o", "pgid=", "-p", String(pid)])
  const group = Number(run.stdout.trim())
  return run.code === 0 && Number.isSafeInteger(group) && group > 0
    ? group
    : undefined
}

/**
 * Each port free, or held by what the stack's pid file names for it: the process group on
 * macOS and Linux, the pid itself on Windows.
 */
async function checkPorts(
  deps: DoctorDeps,
  config: StackConfig
): Promise<Check[]> {
  const checks: Check[] = []
  for (const spec of config.processes) {
    const listeners = await listenersOn(deps.exec, spec.port, deps.platform)
    if (listeners.length === 0) {
      checks.push(ok("ports", `${spec.port} (${spec.name}) is free`))
      continue
    }
    const record = parsePidRecordText(
      deps.files.read(pidFilePath(config, spec.name))
    )
    const foreign: typeof listeners = []
    for (const listener of listeners) {
      const owner =
        deps.platform === "win32"
          ? listener.pid
          : await groupOf(deps.exec, listener.pid)
      if (record === undefined || owner !== record.pid) foreign.push(listener)
    }
    const pids = foreign.map((l) => l.pid)
    checks.push(
      foreign.length === 0
        ? ok(
            "ports",
            `${spec.port} (${spec.name}) is held by the running stack (pid ${record?.pid})`
          )
        : fail(
            "ports",
            `${spec.port} (${spec.name}) is in use by ${describeListeners(foreign)}`,
            fix(
              "free-port",
              `${
                deps.platform === "win32"
                  ? pids.map((pid) => `taskkill /PID ${pid}`).join(" & ")
                  : `kill ${pids.join(" ")}`
              }, or set ${PORT_VARIABLES[spec.name]} in stack.env`
            )
          )
    )
  }
  return checks
}

const parsePidRecordText = (text: string | undefined) =>
  text === undefined ? undefined : parsePidRecord(text)

/** Every check for the platform, in a fixed order; `ports` last, since start runs its own. */
export async function runDoctor(
  deps: DoctorDeps,
  options: DoctorOptions
): Promise<Check[]> {
  const checks: Check[] = [checkNode(deps), checkDependencies(deps)]
  if (deps.platform === "win32") checks.push(checkSettingsAccess())
  let host = set(deps.env, "EIDO_TAILNET_HOST")
  if (options.serve) {
    const tailscale = await checkTailscale(deps)
    checks.push(tailscale.check)
    host ??= tailscale.host
  }
  let config: StackConfig | undefined
  try {
    config = buildStackConfig({
      mode: "prod",
      platform: deps.platform,
      env: deps.env,
      home: deps.home,
      repoRoot: deps.repoRoot,
      nodePath: "node",
      tailnetHost: host ?? "localhost",
    })
  } catch (error) {
    checks.push(
      fail(
        "stack-config",
        (error as Error).message,
        fix("fix-settings", "pnpm stack:setup")
      )
    )
  }
  const edgeOrigin =
    options.serve && host !== undefined && config !== undefined
      ? new URL(config.url).origin
      : undefined
  checks.push(
    checkWebEnv(deps, edgeOrigin),
    deps.platform === "darwin" ? await checkKeychain(deps) : checkVault(deps),
    checkPush(deps),
    ...(await checkLlama(deps, options.quick)),
    checkGmail(deps)
  )
  if (config !== undefined) checks.push(...(await checkPorts(deps, config)))
  return checks
}

/** The lines doctor prints for a check: status and summary, then the fix under it. */
export function formatCheck(check: Check): string[] {
  const head = `${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.summary}`
  return check.fix === undefined || check.status === "ok"
    ? [head]
    : [head, `     fix: ${check.fix.text}`]
}

export const failed = (checks: readonly Check[]): Check[] =>
  checks.filter((check) => check.status === "fail")
