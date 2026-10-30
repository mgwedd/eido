// The `tailscale serve` edge for Eido (ADR 0004, #178). Eido gets its own HTTPS port on the
// node's *.ts.net name and three routes on it, each to a loopback target:
//   /          -> Next (shell, service worker, manifest)
//   /api/core  -> core's API (no auth; tailnet trusted)
//   /api/gate  -> the gate's phone listener (passkey session)
// Nothing on any other serve port is read for the route check, changed or removed: other apps
// on the same host keep their own ports. Funnel must stay off for Eido's port.

export const DEFAULT_EIDO_PORT = 8443
export const DEFAULT_WEB_PORT = 3000
/** Core's own default (`DEFAULT_CORE_PORT` in packages/core/src/main.ts). */
export const DEFAULT_CORE_PORT = 8789
/** The gate's phone listener has no default; EIDO_GATE_PHONE_PORT must be set to this. */
export const DEFAULT_GATE_PORT = 8788

export type EdgeConfig = {
  /** The HTTPS port serve listens on for Eido. */
  port: number
  webPort: number
  corePort: number
  gatePort: number
}

export type Route = {
  name: "web" | "core" | "gate"
  path: string
  target: string
}

export function routesFor(config: EdgeConfig): Route[] {
  const target = (port: number) => `http://127.0.0.1:${port}`
  return [
    { name: "web", path: "/", target: target(config.webPort) },
    { name: "core", path: "/api/core", target: target(config.corePort) },
    { name: "gate", path: "/api/gate", target: target(config.gatePort) },
  ]
}

/** The `tailscale` arguments that apply each route; `--bg` keeps them across reboots. */
export function applyCommands(config: EdgeConfig): string[][] {
  return routesFor(config).map((route) => [
    "serve",
    "--bg",
    `--https=${config.port}`,
    `--set-path=${route.path}`,
    route.target,
  ])
}

export function parsePort(value: string, name: string): number {
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new Error(
      `${name} must be a port number, not ${JSON.stringify(value)}`
    )
  return Number(value)
}

const FLAGS = {
  "--port": "port",
  "--web-port": "webPort",
  "--core-port": "corePort",
  "--gate-port": "gatePort",
} as const

/** Reads `--port`, `--web-port`, `--core-port` and `--gate-port` (`--flag=N` or `--flag N`). */
export function parseEdgeConfig(args: readonly string[]): EdgeConfig {
  const config: EdgeConfig = {
    port: DEFAULT_EIDO_PORT,
    webPort: DEFAULT_WEB_PORT,
    corePort: DEFAULT_CORE_PORT,
    gatePort: DEFAULT_GATE_PORT,
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    const [flag = "", inline] = arg.split("=", 2)
    if (!(flag in FLAGS))
      throw new Error(`unknown argument ${JSON.stringify(arg)}`)
    const value = inline ?? args[++i]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    config[FLAGS[flag as keyof typeof FLAGS]] = parsePort(value, flag)
  }
  const backends = [config.webPort, config.corePort, config.gatePort]
  if (new Set(backends).size !== backends.length)
    throw new Error("the web, core and gate ports must differ")
  return config
}

// The parts of ipn.ServeConfig (`tailscale serve status --json`) this script reads.
type Handler = { Proxy?: string; Path?: string; Text?: string }
type TcpPortHandler = {
  HTTPS?: boolean
  HTTP?: boolean
  TCPForward?: string
  TerminateTLS?: string
}
export type ServeConfig = {
  TCP?: Record<string, TcpPortHandler>
  Web?: Record<string, { Handlers?: Record<string, Handler> }>
  AllowFunnel?: Record<string, boolean>
  Foreground?: Record<string, ServeConfig>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Parses the JSON printed by `tailscale serve status --json` or `tailscale funnel status --json`. */
export function parseServeConfig(text: string): ServeConfig {
  let value: unknown
  try {
    value = JSON.parse(text.trim() === "" ? "{}" : text)
  } catch {
    throw new Error("tailscale printed a serve status that is not JSON")
  }
  if (!isRecord(value))
    throw new Error("tailscale serve status is not a JSON object")
  for (const key of ["TCP", "Web", "AllowFunnel", "Foreground"] as const) {
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      !isRecord(value[key])
    )
      throw new Error(`tailscale serve status has a malformed ${key}`)
  }
  return value
}

export type Problem = {
  /** missing and wrong-target are fixed by apply; foreign must be removed by hand. */
  kind: "missing" | "wrong-target" | "foreign" | "funnel"
  message: string
}

export type CheckResult = { problems: Problem[]; warnings: string[] }

const onPort = (hostPort: string, port: number) => hostPort.endsWith(`:${port}`)

/**
 * Checks the serve config for Eido's port only: exactly the three routes, each to its loopback
 * target, served as HTTPS, and funnel off. Routes on other ports are ignored; funnel on another
 * port is a warning, because it exposes another app, not Eido's backends.
 */
export function checkServeConfig(
  serve: ServeConfig,
  config: EdgeConfig
): CheckResult {
  const problems: Problem[] = []
  const warnings: string[] = []
  const port = config.port
  const expected = routesFor(config)

  const tcp = serve.TCP?.[String(port)]
  if (tcp === undefined) {
    problems.push({
      kind: "missing",
      message: `nothing is served on port ${port}`,
    })
  } else if (
    tcp.HTTPS !== true ||
    tcp.TCPForward !== undefined ||
    tcp.HTTP === true
  ) {
    problems.push({
      kind: "foreign",
      message: `port ${port} is not a plain HTTPS serve port (it is ${JSON.stringify(tcp)})`,
    })
  }

  const hosts = Object.keys(serve.Web ?? {}).filter((hostPort) =>
    onPort(hostPort, port)
  )
  if (hosts.length > 1)
    problems.push({
      kind: "foreign",
      message: `port ${port} is served for more than one name: ${hosts.join(", ")}`,
    })
  const handlers: Record<string, Handler> = {}
  for (const hostPort of hosts)
    Object.assign(handlers, serve.Web?.[hostPort]?.Handlers ?? {})

  for (const route of expected) {
    const handler = handlers[route.path]
    if (handler === undefined) {
      problems.push({
        kind: "missing",
        message: `${route.path} is not served on port ${port}`,
      })
    } else if (
      handler.Proxy !== route.target ||
      handler.Path !== undefined ||
      handler.Text !== undefined
    ) {
      problems.push({
        kind: "wrong-target",
        message: `${route.path} serves ${JSON.stringify(handler)}, expected a proxy to ${route.target}`,
      })
    }
  }
  const known = new Set(expected.map((route) => route.path))
  for (const path of Object.keys(handlers)) {
    if (!known.has(path))
      problems.push({
        kind: "foreign",
        message: `unexpected route ${path} on port ${port}`,
      })
  }

  for (const [hostPort, on] of Object.entries(serve.AllowFunnel ?? {})) {
    if (on !== true) continue
    if (onPort(hostPort, port)) {
      problems.push({
        kind: "funnel",
        message: `funnel is on for port ${port}`,
      })
    } else {
      warnings.push(
        `funnel is on for another port (${hostPort.slice(hostPort.lastIndexOf(":") + 1)}); left alone`
      )
    }
  }

  for (const [id, session] of Object.entries(serve.Foreground ?? {})) {
    const uses =
      session.TCP?.[String(port)] !== undefined ||
      Object.keys(session.Web ?? {}).some((hostPort) => onPort(hostPort, port))
    if (uses)
      problems.push({
        kind: "foreign",
        message: `a foreground serve session (${id}) uses port ${port}`,
      })
  }

  return { problems, warnings }
}

/** Problems that apply cannot fix; apply refuses to start while any remain. */
export function blockingProblems(result: CheckResult): Problem[] {
  return result.problems.filter(
    (p) => p.kind === "foreign" || p.kind === "funnel"
  )
}

/** The node's MagicDNS name from `tailscale status --json`, without the trailing dot. */
export function parseDnsName(text: string): string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error("tailscale status is not JSON")
  }
  const self = isRecord(value) ? value["Self"] : undefined
  const name = isRecord(self) ? self["DNSName"] : undefined
  if (typeof name !== "string" || name === "")
    throw new Error("tailscale status has no Self.DNSName; is MagicDNS on?")
  return name.replace(/\.$/, "")
}
