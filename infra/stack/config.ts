// The local stack's one typed config (#374): where each process keeps its data, sockets and log,
// which loopback port it listens on, the Host headers it answers, and the WebAuthn origin. Every
// value has a default and an env override; nothing here is a secret. Hosts are fixed to
// 127.0.0.1: the stack never binds any other interface.
import { join } from "node:path"

import { parsePort } from "../tailscale/serve-routes.ts"

export type Mode = "dev" | "prod"
export type ProcessName = "gate" | "core" | "web"
export type Env = Readonly<Record<string, string | undefined>>

export const LOOPBACK = "127.0.0.1"

export const DEFAULTS = {
  /** The HTTPS port `tailscale serve` listens on for Eido (ADR 0004). */
  edgePort: 8443,
  webPort: 3000,
  /** Not 8787: another app on the Mac uses it (#372). */
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
  "EIDO_WEBAUTHN_RP_ID",
  "EIDO_WEBAUTHN_ORIGIN",
  "EIDO_GATE_PHONE_BASE_PATH",
  "EIDO_CORE_BASE_PATH",
  "EIDO_GATE_PHONE_ALLOWED_HOSTS",
  "EIDO_CORE_ALLOWED_HOSTS",
] as const

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

export function buildStackConfig(input: ConfigInput): StackConfig {
  const { env, mode, repoRoot } = input
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

  const stackDir = read(
    env,
    "EIDO_STACK_DIR",
    join(input.home, "Library", "Application Support", "eido-dev")
  )
  const logDir = read(
    env,
    "EIDO_STACK_LOG_DIR",
    join(input.home, "Library", "Logs", "eido-dev")
  )
  const runDir = join(stackDir, "run")
  const gateDataDir = read(env, "EIDO_GATE_DATA_DIR", join(stackDir, "gate"))
  const coreDataDir = read(env, "EIDO_DATA_DIR", join(stackDir, "core"))
  const gateSocket = read(
    env,
    "EIDO_GATE_SOCKET",
    join(runDir, "gate-data-plane.sock")
  )
  const controlSocket = read(
    env,
    "EIDO_GATE_CONTROL_SOCKET",
    join(runDir, "gate-control.sock")
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
      EIDO_GATE_DATA_DIR: gateDataDir,
      EIDO_GATE_SOCKET: gateSocket,
      EIDO_GATE_CONTROL_SOCKET: controlSocket,
      EIDO_WEBAUTHN_RP_ID: read(env, "EIDO_WEBAUTHN_RP_ID", tailnetHost),
      EIDO_WEBAUTHN_ORIGIN: read(env, "EIDO_WEBAUTHN_ORIGIN", url.origin),
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
