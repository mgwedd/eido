// The local stack's one typed config (#374): where each process keeps its data, sockets and log,
// which loopback port it listens on, the Host headers it answers, and the WebAuthn origin. Every
// value has a default and an env override; nothing here is a secret. Hosts are fixed to
// 127.0.0.1: the stack never binds any other interface.
import { posix, win32 } from "node:path"

import { parsePort } from "../tailscale/serve-routes.ts"

export type Mode = "dev" | "prod"
/** The platforms the stack tells apart; every other POSIX system is treated as linux. */
export type Platform = "darwin" | "win32" | "linux"

export const platformOf = (platform: string): Platform =>
  platform === "darwin" || platform === "win32" ? platform : "linux"

/** Path functions for `platform`, so a win32 config built on a Mac still has win32 paths. */
export const pathsFor = (platform: Platform) =>
  platform === "win32" ? win32 : posix
export type ProcessName = "gate" | "core" | "web"
export type Env = Readonly<Record<string, string | undefined>>

export const LOOPBACK = "127.0.0.1"

export const DEFAULTS = {
  /** The HTTPS port `tailscale serve` listens on for Eido (ADR 0004). */
  edgePort: 8443,
  webPort: 3000,
  /** Same as core's default; 8787 belongs to another app on the Mac (#372). */
  corePort: 8789,
  gatePort: 8788,
} as const

/** Environment variables that override a default; each is read in `buildStackConfig`. */
export const OVERRIDES = [
  "EIDO_STACK_DIR",
  "EIDO_STACK_LOG_DIR",
  "EIDO_TAILNET_HOST",
  "EIDO_EDGE_PORT",
  "EIDO_WEB_PORT",
  "EIDO_CORE_PORT",
  "EIDO_GATE_PHONE_PORT",
  "EIDO_GATE_DATA_DIR",
  "EIDO_DATA_DIR",
  "EIDO_GATE_SOCKET",
  "EIDO_GATE_CONTROL_SOCKET",
  "EIDO_GATE_KEYCHAIN_PATH",
  "EIDO_PROFILE_AUDIT_EPOCH",
  "EIDO_FILE_HELPER_PATH",
  "EIDO_FILE_HELPER_SHA256",
  "EIDO_FILES_SYNC",
  "EIDO_WEBAUTHN_RP_ID",
  "EIDO_WEBAUTHN_ORIGIN",
  "EIDO_GOOGLE_REDIRECT_URI",
  "EIDO_GATE_PHONE_BASE_PATH",
  "EIDO_CORE_BASE_PATH",
  "EIDO_GATE_PHONE_ALLOWED_HOSTS",
  "EIDO_CORE_ALLOWED_HOSTS",
] as const

/**
 * Settings the stack does not read itself but hands to one process when they are set and
 * non-empty, so a value from `stack.env` reaches it. None is a secret.
 */
export const PASS_THROUGH = {
  gate: [
    // Native code runs in the gate only; local setup selects the installed binary.
    "EIDO_EVENTKIT_HELPER",
    // Web Push turns on in the gate when a subject is set; it also needs the Keychain vault.
    "EIDO_PUSH_VAPID_SUBJECT",
    "EIDO_PUSH_WINDOW_MS",
    "EIDO_GOOGLE_CLIENT_ID",
    "EIDO_GMAIL_CLIENT_ID",
    "EIDO_GMAIL_READ_CLIENT_ID",
    "EIDO_DRIVE_CLIENT_ID",
    "EIDO_BRIDGE_HOST",
    "EIDO_BRIDGE_USERNAME",
    "EIDO_BRIDGE_IMAP_PORT",
    "EIDO_BRIDGE_SMTP_PORT",
    "EIDO_BRIDGE_TLS",
    "EIDO_BRIDGE_CERT_PATH",
    "EIDO_BRIDGE_CERT_SHA256",
    "EIDO_BRIDGE_ALLOW_SELF_SIGNED",
    "EIDO_BRIDGE_SEARCH_FOLDERS",
    // The development file vault: the only gate vault on Windows and Linux for now (#455).
    "EIDO_DEV_VAULT",
    "EIDO_GATE_VAULT_FILE",
  ],
  core: [
    "EIDO_LLAMA_HOST",
    "EIDO_LLAMA_PORT",
    "EIDO_LLAMA_CHAT_TEMPLATE_KWARGS",
  ],
} as const

/** `{ [name]: value }` for each name set and non-empty in `env`. */
function passThrough(
  env: Env,
  names: readonly string[]
): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value !== "") picked[name] = value
  }
  return picked
}

export type ProcessSpec = {
  name: ProcessName
  cwd: string
  command: string
  args: string[]
  /** Variables set for this process on top of the inherited environment. */
  env: Record<string, string>
  port: number
  /** Answers when the process is up; any status below 500 counts. */
  healthUrl: string
  /** A substring of the process's command line, checked before a stop signals a pid from a pid file. */
  marker: string
  /** How long start waits for the health check before giving up. */
  readyTimeoutMs: number
}

export type StackConfig = {
  mode: Mode
  platform: Platform
  stackDir: string
  runDir: string
  logDir: string
  tailnetHost: string
  edgePort: number
  ports: { web: number; core: number; gate: number }
  gateSocket: string
  /** The URL to open once the serve routes are on. */
  url: string
  /** The `serve-routes` flags that describe this stack's routes. */
  serveFlags: string[]
  /** In start order: gate, core, web. */
  processes: ProcessSpec[]
  /** Directories created with mode 700 before start. */
  privateDirs: string[]
}

export type ConfigInput = {
  mode: Mode
  /** Defaults to darwin for callers that run on macOS only, such as infra/backup. */
  platform?: Platform
  env: Env
  home: string
  repoRoot: string
  /** The node binary that runs the gate, core and Next. */
  nodePath: string
  /** The node's MagicDNS name; `EIDO_TAILNET_HOST` wins over it. */
  tailnetHost: string
}

const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i

const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"]
const TS_ENTRY = ["--import", "./src/ts-hooks.ts", "./src/main.ts"]

/** The value of `name` in `env`, or `fallback` when it is unset or empty. */
function read(
  env: Env,
  name: (typeof OVERRIDES)[number],
  fallback: string
): string {
  const value = env[name]
  return value === undefined || value === "" ? fallback : value
}

/** Like `read`, but an empty string is a real value (an empty base path means "no prefix"). */
function readAllowEmpty(
  env: Env,
  name: (typeof OVERRIDES)[number],
  fallback: string
): string {
  return env[name] ?? fallback
}

function readPort(
  env: Env,
  name: (typeof OVERRIDES)[number],
  fallback: number
): number {
  return parsePort(read(env, name, String(fallback)), name)
}

/** Host headers a backend on `port` answers: loopback by address and name, and the tailnet name. */
export function allowedHosts(
  port: number,
  tailnetHost: string,
  edgePort: number
): string {
  return [
    `${LOOPBACK}:${port}`,
    `localhost:${port}`,
    tailnetHost,
    `${tailnetHost}:${edgePort}`,
  ].join(",")
}

/**
 * Where the stack keeps data and logs before any override: Application Support and Logs on
 * macOS, %LOCALAPPDATA%\eido-dev on Windows, the XDG data and state dirs elsewhere.
 */
export function defaultDirs(
  platform: Platform,
  env: Env,
  home: string
): { stackDir: string; logDir: string } {
  const join = (...parts: string[]) => pathsFor(platform).join(...parts)
  const given = (name: string) => {
    const value = env[name]
    return value === undefined || value === "" ? undefined : value
  }
  switch (platform) {
    case "darwin":
      return {
        stackDir: join(home, "Library", "Application Support", "eido-dev"),
        logDir: join(home, "Library", "Logs", "eido-dev"),
      }
    case "win32": {
      const local = given("LOCALAPPDATA") ?? join(home, "AppData", "Local")
      const stackDir = join(local, "eido-dev")
      return { stackDir, logDir: join(stackDir, "logs") }
    }
    case "linux":
      return {
        stackDir: join(
          given("XDG_DATA_HOME") ?? join(home, ".local", "share"),
          "eido-dev"
        ),
        logDir: join(
          given("XDG_STATE_HOME") ?? join(home, ".local", "state"),
          "eido-dev",
          "logs"
        ),
      }
  }
}

/** The stack dir: EIDO_STACK_DIR, else the platform default. */
export const stackDirOf = (platform: Platform, env: Env, home: string) =>
  read(env, "EIDO_STACK_DIR", defaultDirs(platform, env, home).stackDir)

export const pidFilePath = (config: StackConfig, name: ProcessName): string =>
  pathsFor(config.platform).join(config.runDir, `${name}.pid`)

export const logFilePath = (config: StackConfig, name: ProcessName): string =>
  pathsFor(config.platform).join(config.logDir, `${name}.log`)

export function buildStackConfig(input: ConfigInput): StackConfig {
  const { env, mode, repoRoot, platform = "darwin" } = input
  const join = (...parts: string[]) => pathsFor(platform).join(...parts)
  const tailnetHost = read(env, "EIDO_TAILNET_HOST", input.tailnetHost)
  if (!HOSTNAME.test(tailnetHost))
    throw new Error(
      `EIDO_TAILNET_HOST must be a host name, not ${JSON.stringify(tailnetHost)}`
    )
  const edgePort = readPort(env, "EIDO_EDGE_PORT", DEFAULTS.edgePort)
  const ports = {
    web: readPort(env, "EIDO_WEB_PORT", DEFAULTS.webPort),
    core: readPort(env, "EIDO_CORE_PORT", DEFAULTS.corePort),
    gate: readPort(env, "EIDO_GATE_PHONE_PORT", DEFAULTS.gatePort),
  }
  if (new Set(Object.values(ports)).size !== 3)
    throw new Error(
      "EIDO_WEB_PORT, EIDO_CORE_PORT and EIDO_GATE_PHONE_PORT must differ"
    )

  const dirs = defaultDirs(platform, env, input.home)
  const stackDir = read(env, "EIDO_STACK_DIR", dirs.stackDir)
  const logDir = read(env, "EIDO_STACK_LOG_DIR", dirs.logDir)
  const runDir = join(stackDir, "run")
  const gateDataDir = read(env, "EIDO_GATE_DATA_DIR", join(stackDir, "gate"))
  const coreDataDir = read(env, "EIDO_DATA_DIR", join(stackDir, "core"))
  // The gate listens on a Unix socket on macOS and Linux, a named pipe on Windows (ADR 0003).
  const socket = (name: string) =>
    platform === "win32"
      ? `\\\\.\\pipe\\eido-dev-${name}`
      : join(runDir, `${name}.sock`)
  const gateSocket = read(env, "EIDO_GATE_SOCKET", socket("gate-data-plane"))
  const controlSocket = read(
    env,
    "EIDO_GATE_CONTROL_SOCKET",
    socket("gate-control")
  )
  // URL.origin drops a default port, as browsers do when they report the origin.
  const url = new URL(`https://${tailnetHost}:${edgePort}/`)

  const watch = mode === "dev" ? ["--watch"] : []
  const health = (port: number, path: string) =>
    `http://${LOOPBACK}:${port}${path}`

  const gate: ProcessSpec = {
    name: "gate",
    cwd: join(repoRoot, "packages", "gate"),
    command: input.nodePath,
    args: [...watch, ...NODE_FLAGS, ...TS_ENTRY],
    env: {
      ...(env["EIDO_FILE_HELPER_PATH"] === undefined
        ? {}
        : { EIDO_FILE_HELPER_PATH: env["EIDO_FILE_HELPER_PATH"] }),
      ...(env["EIDO_FILE_HELPER_SHA256"] === undefined
        ? {}
        : { EIDO_FILE_HELPER_SHA256: env["EIDO_FILE_HELPER_SHA256"] }),
      EIDO_GATE_DATA_DIR: gateDataDir,
      EIDO_GATE_SOCKET: gateSocket,
      EIDO_GATE_CONTROL_SOCKET: controlSocket,
      // The supervisor's socket (#659), beside the gate's; the gate relays its admin routes there.
      EIDO_GATE_SUPERVISOR_SOCKET: join(runDir, "supervisor.sock"),
      ...(env["EIDO_PROFILE_AUDIT_EPOCH"] === undefined
        ? {}
        : { EIDO_PROFILE_AUDIT_EPOCH: env["EIDO_PROFILE_AUDIT_EPOCH"] }),
      ...(env["EIDO_GATE_KEYCHAIN_PATH"] === undefined ||
      env["EIDO_GATE_KEYCHAIN_PATH"] === ""
        ? {}
        : { EIDO_GATE_KEYCHAIN_PATH: env["EIDO_GATE_KEYCHAIN_PATH"] }),
      // Web Push turns on in the gate when a subject is set; it also needs the Keychain vault.
      ...passThrough(env, PASS_THROUGH.gate),
      EIDO_WEBAUTHN_RP_ID: read(env, "EIDO_WEBAUTHN_RP_ID", tailnetHost),
      EIDO_WEBAUTHN_ORIGIN: read(env, "EIDO_WEBAUTHN_ORIGIN", url.origin),
      // Google returns the browser to the gate's callback through the edge's /api/gate mount (#662).
      EIDO_GOOGLE_REDIRECT_URI: read(
        env,
        "EIDO_GOOGLE_REDIRECT_URI",
        new URL("/api/gate/connect/google/callback", url).toString()
      ),
      EIDO_GATE_PHONE_HOST: LOOPBACK,
      EIDO_GATE_PHONE_PORT: String(ports.gate),
      // Empty: tailscale serve strips the /api/gate mount prefix (measured, #178).
      EIDO_GATE_PHONE_BASE_PATH: readAllowEmpty(
        env,
        "EIDO_GATE_PHONE_BASE_PATH",
        ""
      ),
      EIDO_GATE_PHONE_ALLOWED_HOSTS: read(
        env,
        "EIDO_GATE_PHONE_ALLOWED_HOSTS",
        allowedHosts(ports.gate, tailnetHost, edgePort)
      ),
    },
    port: ports.gate,
    healthUrl: health(ports.gate, "/passkey/status"),
    marker: "src/main.ts",
    readyTimeoutMs: 30_000,
  }
  const core: ProcessSpec = {
    name: "core",
    cwd: join(repoRoot, "packages", "core"),
    command: input.nodePath,
    args: [...watch, ...NODE_FLAGS, ...TS_ENTRY],
    env: {
      ...(env["EIDO_FILES_SYNC"] === undefined
        ? {}
        : { EIDO_FILES_SYNC: env["EIDO_FILES_SYNC"] }),
      ...passThrough(env, PASS_THROUGH.core),
      EIDO_DATA_DIR: coreDataDir,
      EIDO_GATE_SOCKET: gateSocket,
      EIDO_CORE_HOST: LOOPBACK,
      EIDO_CORE_PORT: String(ports.core),
      // Empty: tailscale serve strips the /api/core mount prefix (measured, #178).
      EIDO_CORE_BASE_PATH: readAllowEmpty(env, "EIDO_CORE_BASE_PATH", ""),
      EIDO_CORE_ALLOWED_HOSTS: read(
        env,
        "EIDO_CORE_ALLOWED_HOSTS",
        allowedHosts(ports.core, tailnetHost, edgePort)
      ),
    },
    port: ports.core,
    healthUrl: health(ports.core, "/connectors/health"),
    marker: "src/main.ts",
    readyTimeoutMs: 30_000,
  }
  const web: ProcessSpec = {
    name: "web",
    cwd: join(repoRoot, "apps", "web"),
    command: input.nodePath,
    args: [
      join(
        repoRoot,
        "apps",
        "web",
        "node_modules",
        "next",
        "dist",
        "bin",
        "next"
      ),
      mode === "dev" ? "dev" : "start",
      "-H",
      LOOPBACK,
      "-p",
      String(ports.web),
    ],
    // Read by next.config.ts: lets `next dev` serve HMR and dev assets to the tailnet origin.
    env: { EIDO_TAILNET_HOST: tailnetHost },
    port: ports.web,
    healthUrl: health(ports.web, "/healthz"),
    marker: "next",
    // `next dev` compiles the first page on the first request.
    readyTimeoutMs: mode === "dev" ? 180_000 : 60_000,
  }

  return {
    mode,
    platform,
    stackDir,
    runDir,
    logDir,
    tailnetHost,
    edgePort,
    ports,
    gateSocket,
    url: url.href,
    serveFlags: [
      "--port",
      String(edgePort),
      "--web-port",
      String(ports.web),
      "--core-port",
      String(ports.core),
      "--gate-port",
      String(ports.gate),
    ],
    processes: [gate, core, web],
    privateDirs: [stackDir, runDir, gateDataDir, coreDataDir, logDir],
  }
}
