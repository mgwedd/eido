// Live-host isolation check for the Wave 1 plane split (#56): run on the Mac, after the users,
// sandbox profiles and pf rules from #70 are in place. Not run in CI (no Mac, no users).
//
//   sudo node scripts/check-isolation-live.ts --gate-user <gate user> --data-user <data user> \
//     --intent-socket <path> --control-socket <path> --control-db <path> --gate-keychain <path> \
//     --proxy-port <port> --llama-port <port> --parser-profile <path> \
//     --public-host <hostname> --public-ip <IPv4 address> [--timeout-ms 3000]
//
// It runs as root only to start its children through `sudo -u`: one long-lived child as the gate
// user holds the synthetic canaries (a loopback TCP listener, a Keychain item, a copy of the
// control DB's mode next to it), and each probe runs in a short-lived child, first as the
// data-plane user and then, for every blocked probe, as the gate user with `--as-gate` (the
// positive control, so a FAIL cannot come from a broken probe). It prints one `PASS name` or
// `FAIL name: reason` line per probe and exits 1 on any FAIL. Canaries are random, never printed,
// and removed on exit, on failure and on Ctrl-C. See docs/isolation-tests.md.
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import dns from "node:dns"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { connect, createServer, isIP } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

export type Role = "data" | "gate"

export type ProbeName =
  | "dns"
  | "tcp-public"
  | "loopback-canary"
  | "intent-socket"
  | "proxy"
  | "llama"
  | "keychain"
  | "control-db"
  | "control-socket"
  | "parser"

export type ProbeDef = {
  name: ProbeName
  /** What the data-plane user must see. */
  data: "blocked" | "allowed"
  /** Also run as the gate user, where it must succeed. Every blocked probe has one. */
  control: boolean
  /** The probe targets the canary listener, which must then see no connection from the data user. */
  canaryListener: boolean
  /** Blocked must mean permission denied, not a missing file or a timeout. */
  permission: boolean
}

export const PROBES: readonly ProbeDef[] = [
  probeDef("dns", "blocked"),
  probeDef("tcp-public", "blocked"),
  { ...probeDef("loopback-canary", "blocked"), canaryListener: true },
  probeDef("intent-socket", "allowed"),
  probeDef("proxy", "allowed"),
  probeDef("llama", "allowed"),
  probeDef("keychain", "blocked"),
  { ...probeDef("control-db", "blocked"), permission: true },
  { ...probeDef("control-socket", "blocked"), permission: true },
  { ...probeDef("parser", "blocked"), canaryListener: true },
]

function probeDef(name: ProbeName, data: "blocked" | "allowed"): ProbeDef {
  return {
    name,
    data,
    control: data === "blocked",
    canaryListener: false,
    permission: false,
  }
}

const PERMISSION_CODES = new Set(["EACCES", "EPERM"])

export type ProbeResult =
  { ran: true; reached: boolean; code: string } | { ran: false; code: string }

export type LiveConfig = {
  gateUser: string
  dataUser: string
  intentSocket: string
  controlSocket: string
  controlDb: string
  gateKeychain: string
  proxyPort: number
  llamaPort: number
  parserProfile: string
  publicHost: string
  publicIp: string
  timeoutMs: number
}

/** What the gate-user child created. Digests only: the canary values never leave that child. */
export type Canaries = {
  port: number
  keychainService: string
  keychainDigest: string
  canaryDb: string
  dbDigest: string
}

/** Everything one probe child needs, passed as one JSON argument. */
export type ProbeSpec = {
  name: ProbeName
  gateUser: string
  dataUser: string
  timeoutMs: number
  host?: string
  port?: number
  path?: string
  digest?: string
  keychain?: string
  service?: string
  profile?: string
}

export type LiveRunner = {
  setup: () => Promise<Canaries>
  probe: (role: Role, spec: ProbeSpec) => Promise<ProbeResult>
  /** Connections the canary listener has accepted so far. */
  connections: () => Promise<number>
  teardown: () => Promise<void>
}

/** An error code safe to print: an errno-style name, or "error". Never a message or a value. */
export function safeCode(value: unknown): string {
  const code =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "code" in value
        ? value.code
        : undefined
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code)
    ? code
    : "error"
}

// ---- arguments -------------------------------------------------------------------------------

const STRING_FLAGS = {
  "--gate-user": "gateUser",
  "--data-user": "dataUser",
  "--intent-socket": "intentSocket",
  "--control-socket": "controlSocket",
  "--control-db": "controlDb",
  "--gate-keychain": "gateKeychain",
  "--parser-profile": "parserProfile",
  "--public-host": "publicHost",
  "--public-ip": "publicIp",
} as const

const PORT_FLAGS = {
  "--proxy-port": "proxyPort",
  "--llama-port": "llamaPort",
} as const

const PATH_KEYS = [
  "intentSocket",
  "controlSocket",
  "controlDb",
  "gateKeychain",
  "parserProfile",
] as const

const USER_NAME = /^[a-z_][a-z0-9_.-]{0,31}$/

export const USAGE =
  "usage: sudo node scripts/check-isolation-live.ts --gate-user <user> --data-user <user> " +
  "--intent-socket <path> --control-socket <path> --control-db <path> --gate-keychain <path> " +
  "--proxy-port <port> --llama-port <port> --parser-profile <path> --public-host <hostname> " +
  "--public-ip <IPv4> [--timeout-ms <ms>]"

function isKey<T extends object>(
  table: T,
  key: string
): key is Extract<keyof T, string> {
  return Object.hasOwn(table, key)
}

/** Parses the run arguments; every problem is listed, so one run shows them all. */
export function parseArgs(
  argv: readonly string[]
): { ok: true; config: LiveConfig } | { ok: false; errors: string[] } {
  const strings: Partial<
    Record<(typeof STRING_FLAGS)[keyof typeof STRING_FLAGS], string>
  > = {}
  const ports: Partial<
    Record<(typeof PORT_FLAGS)[keyof typeof PORT_FLAGS], number>
  > = {}
  let timeoutMs = 3000
  const errors: string[] = []
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? ""
    const value = argv[i + 1]
    if (value === undefined || value.startsWith("--")) {
      errors.push(`${flag} needs a value`)
      i -= 1
      continue
    }
    if (isKey(STRING_FLAGS, flag)) strings[STRING_FLAGS[flag]] = value
    else if (isKey(PORT_FLAGS, flag)) {
      const port = Number(value)
      if (Number.isInteger(port) && port > 0 && port < 65536)
        ports[PORT_FLAGS[flag]] = port
      else errors.push(`${flag} must be a TCP port`)
    } else if (flag === "--timeout-ms") {
      timeoutMs = Number(value)
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000)
        errors.push("--timeout-ms must be between 100 and 60000")
    } else errors.push(`unknown argument ${flag}`)
  }
  for (const [flag, key] of Object.entries(STRING_FLAGS))
    if (strings[key] === undefined) errors.push(`${flag} is required`)
  for (const [flag, key] of Object.entries(PORT_FLAGS))
    if (
      ports[key] === undefined &&
      !errors.includes(`${flag} must be a TCP port`)
    )
      errors.push(`${flag} is required`)
  for (const key of ["gateUser", "dataUser"] as const) {
    const name = strings[key]
    if (name !== undefined && !USER_NAME.test(name))
      errors.push(
        `${key === "gateUser" ? "--gate-user" : "--data-user"} is not a user name`
      )
  }
  if (strings.gateUser !== undefined && strings.gateUser === strings.dataUser)
    errors.push("--gate-user and --data-user must be different users")
  for (const key of PATH_KEYS) {
    const path = strings[key]
    if (path !== undefined && !isAbsolute(path))
      errors.push(`the ${key} path must be absolute`)
  }
  if (strings.publicIp !== undefined && isIP(strings.publicIp) !== 4)
    errors.push("--public-ip must be an IPv4 address")
  const {
    gateUser,
    dataUser,
    intentSocket,
    controlSocket,
    controlDb,
    gateKeychain,
    parserProfile,
    publicHost,
    publicIp,
  } = strings
  const { proxyPort, llamaPort } = ports
  if (
    errors.length > 0 ||
    gateUser === undefined ||
    dataUser === undefined ||
    intentSocket === undefined ||
    controlSocket === undefined ||
    controlDb === undefined ||
    gateKeychain === undefined ||
    parserProfile === undefined ||
    publicHost === undefined ||
    publicIp === undefined ||
    proxyPort === undefined ||
    llamaPort === undefined
  )
    return { ok: false, errors }
  return {
    ok: true,
    config: {
      gateUser,
      dataUser,
      intentSocket,
      controlSocket,
      controlDb,
      gateKeychain,
      proxyPort,
      llamaPort,
      parserProfile,
      publicHost,
      publicIp,
      timeoutMs,
    },
  }
}

/**
 * Why this process must not go on, or undefined. The run needs root (it starts its children with
 * `sudo -u`); a probe runs as the data-plane user, or as the gate user only with `--as-gate`, so a
 * probe run by the gate user by mistake cannot pass for a data-plane result.
 */
export function refusal(
  mode: "run" | "probe" | "canaries",
  who: { user: string; uid: number },
  users: { gateUser: string; dataUser: string },
  asGate: boolean
): string | undefined {
  if (mode === "run") {
    if (who.user === users.gateUser)
      return "refusing to run as the gate user: run the whole check with sudo, from an admin account"
    return who.uid === 0
      ? undefined
      : "run with sudo: the check starts its probes as each user with sudo -u"
  }
  if (mode === "canaries")
    return who.user === users.gateUser
      ? undefined
      : "the canaries must be created by the gate user"
  if (who.user === users.gateUser && !asGate)
    return "refusing to probe as the gate user without --as-gate: the result would not be the data plane's"
  if (asGate && who.user !== users.gateUser)
    return "--as-gate is the positive control and runs as the gate user only"
  if (!asGate && who.user !== users.dataUser)
    return "probes run as the data-plane user (or as the gate user with --as-gate)"
  return undefined
}

// ---- judging ---------------------------------------------------------------------------------

/** The spec one probe child gets. */
export function probeSpec(
  name: ProbeName,
  config: LiveConfig,
  canaries: Canaries
): ProbeSpec {
  const base = {
    name,
    gateUser: config.gateUser,
    dataUser: config.dataUser,
    timeoutMs: config.timeoutMs,
  }
  switch (name) {
    case "dns":
      return { ...base, host: config.publicHost }
    case "tcp-public":
      return { ...base, host: config.publicIp, port: 443 }
    case "loopback-canary":
      return { ...base, host: "127.0.0.1", port: canaries.port }
    case "intent-socket":
      return { ...base, path: config.intentSocket }
    case "proxy":
      return { ...base, host: "127.0.0.1", port: config.proxyPort }
    case "llama":
      return { ...base, host: "127.0.0.1", port: config.llamaPort }
    case "keychain":
      return {
        ...base,
        keychain: config.gateKeychain,
        service: canaries.keychainService,
        digest: canaries.keychainDigest,
      }
    case "control-db":
      return { ...base, path: canaries.canaryDb, digest: canaries.dbDigest }
    case "control-socket":
      return { ...base, path: config.controlSocket }
    case "parser":
      return { ...base, port: canaries.port, profile: config.parserProfile }
  }
}

/** One output line for one probe run. `newConnections` is the canary listener's count change. */
export function judge(
  def: ProbeDef,
  role: Role,
  result: ProbeResult,
  newConnections: number
): string {
  const label = role === "data" ? def.name : `${def.name}.control`
  const code = safeCode(result.code)
  if (!result.ran) return `FAIL ${label}: the probe did not run (${code})`
  if (role === "gate") {
    const listenerSaw = !def.canaryListener || newConnections > 0
    return result.reached && code === "OK" && listenerSaw
      ? `PASS ${label}`
      : `FAIL ${label}: the gate user could not do it either (${code}), so the probe proves nothing`
  }
  if (def.data === "allowed")
    return result.reached
      ? `PASS ${label}`
      : `FAIL ${label}: the data-plane user cannot reach an allowed endpoint (${code})`
  if (result.reached) return `FAIL ${label}: reached as the data-plane user`
  if (def.canaryListener && newConnections > 0)
    return `FAIL ${label}: the canary listener saw ${String(newConnections)} connection(s)`
  if (def.permission && !PERMISSION_CODES.has(code))
    return `FAIL ${label}: refused with ${code}, not permission denied`
  return `PASS ${label} (${code})`
}

/** Runs every probe through `runner` and prints a line each. Returns the exit code. */
export async function runLive(
  config: LiveConfig,
  runner: LiveRunner,
  print: (line: string) => void
): Promise<number> {
  let failed = false
  const report = (line: string) => {
    if (line.startsWith("FAIL")) failed = true
    print(line)
  }
  const attempt = async (role: Role, spec: ProbeSpec): Promise<ProbeResult> => {
    try {
      return await runner.probe(role, spec)
    } catch (error) {
      return { ran: false, code: safeCode(error) }
    }
  }
  try {
    let canaries: Canaries | undefined
    try {
      canaries = await runner.setup()
    } catch (error) {
      report(
        `FAIL setup: the canaries could not be created (${safeCode(error)})`
      )
    }
    if (canaries !== undefined) {
      for (const def of PROBES) {
        const spec = probeSpec(def.name, config, canaries)
        for (const role of def.control
          ? (["data", "gate"] as const)
          : (["data"] as const)) {
          const before = def.canaryListener ? await runner.connections() : 0
          const result = await attempt(role, spec)
          const after = def.canaryListener ? await runner.connections() : 0
          report(judge(def, role, result, after - before))
        }
      }
    }
  } finally {
    try {
      await runner.teardown()
    } catch (error) {
      report(`FAIL cleanup: a canary may be left behind (${safeCode(error)})`)
    }
  }
  return failed ? 1 : 0
}

// ---- canaries (the gate-user child) ------------------------------------------------------------

export type CanaryListener = {
  port: number
  connections: () => number
  close: () => Promise<void>
}

/** The side effects of canary creation, injected so the cleanup order can be tested. */
export type CanaryHost = {
  listen: () => Promise<CanaryListener>
  addKeychainItem: (keychain: string, service: string, secret: string) => void
  deleteKeychainItem: (keychain: string, service: string) => void
  modeOf: (path: string) => number
  writeFile: (path: string, bytes: Buffer, mode: number) => void
  removeFile: (path: string) => void
  random: (bytes: number) => Buffer
}

export type CanarySet = {
  canaries: Canaries
  connections: () => number
  /** Removes everything; returns the steps that could not be undone. */
  cleanup: () => Promise<string[]>
}

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex")

/**
 * Creates the listener, the Keychain item and the control DB canary, in that order. If a step
 * fails, the steps already done are undone before the error is rethrown.
 */
export async function createCanaries(
  spec: { controlDb: string; gateKeychain: string },
  host: CanaryHost
): Promise<CanarySet> {
  const undo: [step: string, run: () => Promise<void> | void][] = []
  const cleanup = async (): Promise<string[]> => {
    const failed: string[] = []
    for (const [step, run] of undo.reverse()) {
      try {
        await run()
      } catch {
        failed.push(step)
      }
    }
    undo.length = 0
    return failed
  }
  try {
    const listener = await host.listen()
    undo.push(["listener", () => listener.close()])
    const tag = host.random(8).toString("hex")
    const service = `eido-isolation-canary-${tag}`
    const secret = host.random(32).toString("hex")
    host.addKeychainItem(spec.gateKeychain, service, secret)
    undo.push([
      "keychain",
      () => host.deleteKeychainItem(spec.gateKeychain, service),
    ])
    const canaryDb = join(
      dirname(spec.controlDb),
      `.eido-isolation-canary-${tag}.db`
    )
    const bytes = host.random(64)
    host.writeFile(canaryDb, bytes, host.modeOf(spec.controlDb) & 0o777)
    undo.push(["control-db", () => host.removeFile(canaryDb)])
    return {
      canaries: {
        port: listener.port,
        keychainService: service,
        keychainDigest: sha256(secret),
        canaryDb,
        dbDigest: sha256(bytes),
      },
      connections: listener.connections,
      cleanup,
    }
  } catch (error) {
    const failed = await cleanup()
    throw Object.assign(new Error("the canaries could not be created"), {
      code: safeCode(error),
      failed,
    })
  }
}

function security(args: readonly string[]): void {
  const run = spawnSync("security", args, { stdio: "ignore" })
  if (run.status !== 0)
    throw Object.assign(new Error("security failed"), {
      code: `SECURITY_EXIT_${String(run.status)}`,
    })
}

const nodeCanaryHost: CanaryHost = {
  listen: () =>
    new Promise((resolve, reject) => {
      let count = 0
      const server = createServer((socket) => {
        count += 1
        socket.destroy()
      })
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        resolve({
          port:
            typeof address === "object" && address !== null ? address.port : 0,
          connections: () => count,
          close: () => new Promise((done) => server.close(() => done())),
        })
      })
    }),
  // The value is a synthetic random string; it is on this child's argv only for the call.
  addKeychainItem: (keychain, service, secret) =>
    security([
      "add-generic-password",
      "-a",
      service,
      "-s",
      service,
      "-w",
      secret,
      keychain,
    ]),
  deleteKeychainItem: (keychain, service) =>
    security(["delete-generic-password", "-s", service, keychain]),
  modeOf: (path) => statSync(path).mode,
  writeFile: (path, bytes, mode) => {
    writeFileSync(path, bytes, { flag: "wx", mode })
    chmodSync(path, mode)
  },
  removeFile: (path) => rmSync(path, { force: true }),
  random: (bytes) => randomBytes(bytes),
}

/** The gate-user child: holds the canaries until stdin closes or a signal arrives. */
async function holdCanaries(spec: {
  controlDb: string
  gateKeychain: string
}): Promise<void> {
  const write = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(value)}\n`)
  let set: CanarySet
  try {
    set = await createCanaries(spec, nodeCanaryHost)
  } catch (error) {
    const failed =
      typeof error === "object" &&
      error !== null &&
      "failed" in error &&
      Array.isArray(error.failed)
        ? error.failed.map(String)
        : []
    write({
      ready: false,
      code: safeCode(error),
      cleaned: failed.length === 0,
      failed,
    })
    process.exitCode = 1
    return
  }
  let done = false
  const finish = async () => {
    if (done) return
    done = true
    const failed = await set.cleanup()
    write({ cleaned: failed.length === 0, failed })
    process.exit(failed.length === 0 ? 0 : 1)
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => void finish())
  write({ ready: true, ...set.canaries })
  const lines = createInterface({ input: process.stdin })
  lines.on("line", (line) => {
    if (line === "count") write({ connections: set.connections() })
  })
  lines.on("close", () => void finish())
}

// ---- probes (the short-lived children) ---------------------------------------------------------

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CORE_HOOKS = join(REPO, "packages", "core", "src", "ts-hooks.ts")
const NETWORK_FIXTURE = join(
  REPO,
  "packages",
  "core",
  "src",
  "parsers",
  "hostile",
  "network.test-support.ts"
)

function reachSocket(
  target: { host: string; port: number } | { path: string },
  timeoutMs: number
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = connect(target)
    const settle = (result: ProbeResult) => {
      socket.destroy()
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(
      () => settle({ ran: true, reached: false, code: "ETIMEDOUT" }),
      timeoutMs
    )
    socket.once("connect", () =>
      settle({ ran: true, reached: true, code: "OK" })
    )
    socket.once("error", (error) =>
      settle({ ran: true, reached: false, code: safeCode(error) })
    )
  })
}

/** Connects to a TCP host and port. */
export function reachTcp(
  host: string,
  port: number,
  timeoutMs: number
): Promise<ProbeResult> {
  return reachSocket({ host, port }, timeoutMs)
}

/** Connects to a Unix socket path. */
export function reachUnixSocket(
  path: string,
  timeoutMs: number
): Promise<ProbeResult> {
  return reachSocket({ path }, timeoutMs)
}

/** Resolves a hostname through the system resolver. */
export async function reachDns(
  host: string,
  timeoutMs: number,
  lookup: (host: string) => Promise<unknown> = (name) =>
    dns.promises.lookup(name)
): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ran: true, reached: false, code: "ETIMEDOUT" }),
      timeoutMs
    )
  })
  const resolved = lookup(host).then(
    (): ProbeResult => ({ ran: true, reached: true, code: "OK" }),
    (error: unknown): ProbeResult => ({
      ran: true,
      reached: false,
      code: safeCode(error),
    })
  )
  try {
    return await Promise.race([resolved, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Reads a file. Reached means it could be read; OK means its content has the expected digest. */
export function readMatches(
  read: () => Buffer | string,
  digest: string
): ProbeResult {
  let content: Buffer | string
  try {
    content = read()
  } catch (error) {
    return { ran: true, reached: false, code: safeCode(error) }
  }
  return {
    ran: true,
    reached: true,
    code: sha256(content) === digest ? "OK" : "DIGEST_MISMATCH",
  }
}

function readKeychain(keychain: string, service: string): string {
  const run = spawnSync(
    "security",
    ["find-generic-password", "-s", service, "-w", keychain],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }
  )
  if (run.status !== 0)
    throw Object.assign(new Error("security failed"), {
      code: `SECURITY_EXIT_${String(run.status)}`,
    })
  return run.stdout.replace(/\n$/, "")
}

/**
 * Runs the #43 hostile network fixture against the canary port: under the parser sandbox profile
 * as the data-plane user, and without it as the gate user (the control). The no-network preload
 * is left out on purpose, so what is tested is the OS fence, not the in-process one.
 */
function reachFromParser(
  port: number,
  profile: string | undefined,
  timeoutMs: number
): ProbeResult {
  const workDir = mkdtempSync(join(tmpdir(), "eido-isolation-parser-"))
  try {
    const resultPath = join(workDir, "result.json")
    const jobPath = join(workDir, "job.json")
    writeFileSync(
      jobPath,
      JSON.stringify({ resultPath, workDir, payload: { port } }),
      {
        mode: 0o600,
      }
    )
    const node = [
      process.execPath,
      "--disable-warning=ExperimentalWarning",
      "--import",
      CORE_HOOKS,
      NETWORK_FIXTURE,
      jobPath,
    ]
    const [command = "", ...args] =
      profile === undefined ? node : ["sandbox-exec", "-f", profile, ...node]
    spawnSync(command, args, {
      cwd: workDir,
      env: {},
      stdio: "ignore",
      timeout: timeoutMs * 10,
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(resultPath, "utf8"))
    } catch {
      return { ran: false, code: "NO_RESULT" }
    }
    return parserOutcome(parsed)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** Reached when any connect attempt in the fixture's report connected. */
export function parserOutcome(report: unknown): ProbeResult {
  const attempts =
    typeof report === "object" && report !== null && "attempts" in report
      ? report.attempts
      : undefined
  if (!Array.isArray(attempts)) return { ran: false, code: "NO_RESULT" }
  const connected = attempts.some(
    (attempt: unknown) =>
      typeof attempt === "object" &&
      attempt !== null &&
      "name" in attempt &&
      "outcome" in attempt &&
      ["fetch", "net.connect", "http.request"].includes(String(attempt.name)) &&
      attempt.outcome === "connected"
  )
  return { ran: true, reached: connected, code: connected ? "OK" : "BLOCKED" }
}

/** Runs one probe in this process, as whoever this process is. */
export async function runProbe(
  spec: ProbeSpec,
  asGate: boolean
): Promise<ProbeResult> {
  const missing: ProbeResult = { ran: false, code: "BAD_SPEC" }
  switch (spec.name) {
    case "dns":
      return spec.host === undefined
        ? missing
        : await reachDns(spec.host, spec.timeoutMs)
    case "tcp-public":
    case "loopback-canary":
    case "proxy":
    case "llama":
      return spec.host === undefined || spec.port === undefined
        ? missing
        : await reachTcp(spec.host, spec.port, spec.timeoutMs)
    case "intent-socket":
    case "control-socket":
      return spec.path === undefined
        ? missing
        : await reachUnixSocket(spec.path, spec.timeoutMs)
    case "keychain": {
      const { keychain, service, digest } = spec
      return keychain === undefined ||
        service === undefined ||
        digest === undefined
        ? missing
        : readMatches(() => readKeychain(keychain, service), digest)
    }
    case "control-db": {
      const { path, digest } = spec
      return path === undefined || digest === undefined
        ? missing
        : readMatches(() => readFileSync(path), digest)
    }
    case "parser":
      return spec.port === undefined || spec.profile === undefined
        ? missing
        : reachFromParser(
            spec.port,
            asGate ? undefined : spec.profile,
            spec.timeoutMs
          )
  }
}

const PROBE_NAMES: readonly string[] = PROBES.map((def) => def.name)

function isProbeName(value: unknown): value is ProbeName {
  return typeof value === "string" && PROBE_NAMES.includes(value)
}

/** Parses a probe child's spec argument; undefined when it is not one. */
export function parseSpec(text: string): ProbeSpec | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const field = (name: string): unknown =>
    name in value ? Reflect.get(value, name) : undefined
  const name = field("name")
  const gateUser = field("gateUser")
  const dataUser = field("dataUser")
  const timeoutMs = field("timeoutMs")
  if (
    !isProbeName(name) ||
    typeof gateUser !== "string" ||
    typeof dataUser !== "string" ||
    typeof timeoutMs !== "number"
  )
    return undefined
  const spec: ProbeSpec = { name, gateUser, dataUser, timeoutMs }
  for (const key of [
    "host",
    "path",
    "digest",
    "keychain",
    "service",
    "profile",
  ] as const) {
    const v = field(key)
    if (typeof v === "string") spec[key] = v
    else if (v !== undefined) return undefined
  }
  const port = field("port")
  if (typeof port === "number") spec.port = port
  else if (port !== undefined) return undefined
  return spec
}

/** Parses the one JSON line a probe child prints. */
export function parseResult(line: string): ProbeResult {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { ran: false, code: "BAD_OUTPUT" }
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("ran" in value) ||
    !("code" in value)
  )
    return { ran: false, code: "BAD_OUTPUT" }
  const code = safeCode(value.code)
  if (value.ran !== true) return { ran: false, code }
  return "reached" in value && typeof value.reached === "boolean"
    ? { ran: true, reached: value.reached, code }
    : { ran: false, code: "BAD_OUTPUT" }
}

// ---- the real runner (root, through sudo -u) ---------------------------------------------------

const SELF = fileURLToPath(import.meta.url)

function sudoArgs(user: string, args: readonly string[]): string[] {
  return ["-n", "-u", user, "--", process.execPath, SELF, ...args]
}

function sudoRunner(config: LiveConfig): LiveRunner {
  const holder = spawn(
    "sudo",
    sudoArgs(config.gateUser, [
      "canaries",
      "--gate-user",
      config.gateUser,
      "--control-db",
      config.controlDb,
      "--gate-keychain",
      config.gateKeychain,
    ]),
    { cwd: "/", stdio: ["pipe", "pipe", "inherit"] }
  )
  const exited = new Promise<number | null>((resolve) =>
    holder.once("close", resolve)
  )
  const pending: ((message: unknown) => void)[] = []
  let last: unknown
  createInterface({ input: holder.stdout }).on("line", (line) => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      message = undefined
    }
    last = message
    pending.shift()?.(message)
  })
  const next = () =>
    new Promise<unknown>((resolve, reject) => {
      pending.push(resolve)
      void exited.then(() => reject(new Error("the canary holder exited")))
    })
  const field = (value: unknown, name: string): unknown =>
    typeof value === "object" && value !== null && name in value
      ? Reflect.get(value, name)
      : undefined
  return {
    setup: async () => {
      const ready = await next()
      const port = field(ready, "port")
      const keychainService = field(ready, "keychainService")
      const keychainDigest = field(ready, "keychainDigest")
      const canaryDb = field(ready, "canaryDb")
      const dbDigest = field(ready, "dbDigest")
      if (
        field(ready, "ready") !== true ||
        typeof port !== "number" ||
        typeof keychainService !== "string" ||
        typeof keychainDigest !== "string" ||
        typeof canaryDb !== "string" ||
        typeof dbDigest !== "string"
      )
        throw Object.assign(new Error("no canaries"), {
          code: safeCode(field(ready, "code")),
        })
      return { port, keychainService, keychainDigest, canaryDb, dbDigest }
    },
    connections: async () => {
      const reply = next()
      holder.stdin.write("count\n")
      return Number(field(await reply, "connections"))
    },
    probe: (role, spec) => {
      const user = role === "gate" ? config.gateUser : config.dataUser
      const args = [
        "probe",
        "--spec",
        JSON.stringify(spec),
        ...(role === "gate" ? ["--as-gate"] : []),
      ]
      const run = spawnSync("sudo", sudoArgs(user, args), {
        cwd: "/",
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        timeout: config.timeoutMs * 20,
      })
      const line = run.stdout.trim().split("\n").at(-1) ?? ""
      return Promise.resolve(
        run.status === 0
          ? parseResult(line)
          : { ran: false, code: `EXIT_${String(run.status)}` }
      )
    },
    // The holder prints `cleaned` last: after stdin closes, or at once when it could not set up.
    teardown: async () => {
      holder.stdin.end()
      await exited
      if (field(last, "cleaned") !== true)
        throw Object.assign(new Error("cleanup failed"), {
          code: "CANARY_CLEANUP",
        })
    },
  }
}

// ---- entry -------------------------------------------------------------------------------------

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

async function main(argv: readonly string[]): Promise<number> {
  const who = { user: userInfo().username, uid: process.getuid?.() ?? -1 }
  const [mode] = argv
  if (mode === "probe") {
    const spec = parseSpec(flagValue(argv, "--spec") ?? "")
    if (spec === undefined) {
      console.error("probe needs --spec <json>")
      return 2
    }
    const asGate = argv.includes("--as-gate")
    const refused = refusal("probe", who, spec, asGate)
    if (refused !== undefined) {
      console.error(refused)
      return 2
    }
    process.stdout.write(`${JSON.stringify(await runProbe(spec, asGate))}\n`)
    return 0
  }
  if (mode === "canaries") {
    const gateUser = flagValue(argv, "--gate-user") ?? ""
    const controlDb = flagValue(argv, "--control-db") ?? ""
    const gateKeychain = flagValue(argv, "--gate-keychain") ?? ""
    const refused = refusal("canaries", who, { gateUser, dataUser: "" }, false)
    if (refused !== undefined) {
      console.error(refused)
      return 2
    }
    await holdCanaries({ controlDb, gateKeychain })
    return Number(process.exitCode ?? 0)
  }
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    console.error([...parsed.errors, USAGE].join("\n"))
    return 2
  }
  const refused = refusal("run", who, parsed.config, false)
  if (refused !== undefined) {
    console.error(refused)
    return 2
  }
  const runner = sudoRunner(parsed.config)
  return runLive(parsed.config, runner, (line) => console.log(line))
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  // The canary holder keeps its own process alive until stdin closes; everyone else exits here.
  if (process.argv[2] !== "canaries") process.exit(code)
  else process.exitCode = code
}
