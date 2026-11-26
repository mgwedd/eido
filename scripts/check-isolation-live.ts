// Live-host isolation check for the Wave 1 plane split (#56): run on the Mac, after the users,
// sandbox profiles and pf rules from #70 are in place. Not run in CI (no Mac, no users).
//
//   sudo node scripts/check-isolation-live.ts --gate-user <gate user> --data-user <data user> \
//     --intent-socket <path> --control-socket <path> --control-db <path> --gate-keychain <path> \
//     --proxy-port <port> --llama-port <port> --parser-profile <path> --parser-socket <path> \
//     --data-db <path> --public-host <hostname> --public-ip <IPv4 address> \
//     [--data-profile <path>] [--stack-dir <owner's stack dir>] [--timeout-ms 3000]
//
// It runs as root only to start its children through `sudo -u`: one long-lived child as the gate
// user holds the synthetic canaries (a loopback TCP listener, Keychain items, a copy of the
// control DB's mode next to it), and each probe runs in a short-lived child, first as the
// data-plane user (under `sandbox-exec -f <data profile>` when `--data-profile` is given, as the
// data plane runs) and then, for every blocked probe, as the gate user with `--as-gate` (the
// positive control, so a FAIL cannot come from a broken probe). It prints one `PASS name` or
// `FAIL name: reason` line per probe and exits 1 on any FAIL. Canaries are random, never printed,
// and removed on exit, on failure and on Ctrl-C. With `--stack-dir`, two more probes run as the gate
// user alone (#70): it connects to the supervisor socket and reads no other file in the stack's run
// dir. The Keychain is probed three ways: the data-plane user reads a canary item, adds a new item
// and modifies a second canary item in the gate Keychain; all three must fail, and the gate user
// does each as the control (#724). The parse child is probed through the real broker path (#820):
// a probe broker (the production broker, as `_eidoparse` under the installed `parser.sb`) is
// started on a probe socket, a probe job is sent to it as the data-plane user, and its parse child
// reports whether it reached the canary listener, the egress proxy, the llama port, the intent
// socket and `eido-data.db`. Each of those has a witness: a probe that proves an unfenced user
// reaches the same target. See docs/isolation-tests.md.
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcessByStdio } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import dns from "node:dns"
import {
  chmodSync,
  chownSync,
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { connect, createServer, isIP } from "node:net"
import { userInfo } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  SUPERVISOR_DIR_NAME,
  SUPERVISOR_SOCKET_NAME,
} from "../infra/stack/config.ts"
import type { createBrokerClient as CreateBrokerClient } from "../packages/core/src/parsers/broker-client.ts"
import {
  PARSER_PROBE_MIME,
  classifyParserAnswer,
  isParserProbeName,
  parserProbeDocument,
  parserTargetOf,
  safeCode,
} from "./isolation-parser.ts"
import type { ParserProbeName, ParserProbeResult } from "./isolation-parser.ts"
import { buildParserPlan } from "./isolation-parser-plan.ts"

export { safeCode }

export type Role = "data" | "gate"

export type ProbeName =
  | "dns"
  | "tcp-public"
  | "loopback-canary"
  | "intent-socket"
  | "proxy"
  | "llama"
  | "keychain"
  | "keychain-add"
  | "keychain-modify"
  | "control-db"
  | "control-socket"
  | "data-db"
  | "parser-socket"
  | ParserProbeName
  | "supervisor-socket"
  | "run-dir-files"

export type ProbeDef = {
  name: ProbeName
  /** Who is probed: the data-plane user, or the gate user alone (no control run). */
  subject: Role
  /** What the data-plane user must see. */
  data: "blocked" | "allowed"
  /** Also run as the gate user, where it must succeed. Every blocked probe has one. */
  control: boolean
  /** The probe targets the canary listener, which must then see no connection from the data user. */
  canaryListener: boolean
  /** Blocked must mean permission denied, not a missing file or a timeout. */
  permission: boolean
  /**
   * `broker`: the probe is a parse job sent to the probe broker, and the target is tried by the
   * broker's parse child (#820). There is no gate-user control; the witness stands in for it.
   */
  via: "direct" | "broker"
  /**
   * The probe that proves the target can be reached at all, so a blocked result means the fence
   * and not a dead target: it must have run and reached, in that role, earlier in the run.
   */
  witness?: { probe: ProbeName; role: Role }
}

export const PROBES: readonly ProbeDef[] = [
  probeDef("dns", "blocked"),
  probeDef("tcp-public", "blocked"),
  { ...probeDef("loopback-canary", "blocked"), canaryListener: true },
  probeDef("intent-socket", "allowed"),
  probeDef("proxy", "allowed"),
  probeDef("llama", "allowed"),
  probeDef("keychain", "blocked"),
  probeDef("keychain-add", "blocked"),
  probeDef("keychain-modify", "blocked"),
  { ...probeDef("control-db", "blocked"), permission: true },
  { ...probeDef("control-socket", "blocked"), permission: true },
  probeDef("data-db", "allowed"),
  probeDef("parser-socket", "allowed"),
  brokerProbe(
    "parser-loopback",
    { probe: "loopback-canary", role: "gate" },
    {
      canaryListener: true,
    }
  ),
  brokerProbe("parser-proxy", { probe: "proxy", role: "data" }),
  brokerProbe("parser-llama", { probe: "llama", role: "data" }),
  brokerProbe(
    "parser-intent-socket",
    { probe: "intent-socket", role: "data" },
    { permission: true }
  ),
  brokerProbe(
    "parser-data-db",
    { probe: "data-db", role: "data" },
    { permission: true }
  ),
  { ...probeDef("supervisor-socket", "allowed"), subject: "gate" },
  {
    ...probeDef("run-dir-files", "blocked"),
    subject: "gate",
    control: false,
    permission: true,
  },
]

function probeDef(name: ProbeName, data: "blocked" | "allowed"): ProbeDef {
  return {
    name,
    subject: "data",
    data,
    control: data === "blocked",
    canaryListener: false,
    permission: false,
    via: "direct",
  }
}

function brokerProbe(
  name: ParserProbeName,
  witness: { probe: ProbeName; role: Role },
  options: { canaryListener?: boolean; permission?: boolean } = {}
): ProbeDef {
  return {
    ...probeDef(name, "blocked"),
    control: false,
    canaryListener: options.canaryListener ?? false,
    permission: options.permission ?? false,
    via: "broker",
    witness,
  }
}

const PERMISSION_CODES = new Set(["EACCES", "EPERM"])

export type ProbeResult = ParserProbeResult

export type LiveConfig = {
  gateUser: string
  dataUser: string
  intentSocket: string
  controlSocket: string
  controlDb: string
  gateKeychain: string
  proxyPort: number
  llamaPort: number
  /** The installed `parser.sb` (#818): the probe broker runs under it with its socket swapped. */
  parserProfile: string
  /** The production broker's socket, which the installed profile names; the data user must reach it. */
  parserSocket: string
  /** `eido-data.db`: the data plane's own file, which the parse child must not open. */
  dataDb: string
  /** The core sandbox profile: when set, data-plane probes run under `sandbox-exec -f` it. */
  dataProfile?: string
  /** The owner's stack dir: when set, the supervisor probes run (`run/supervisor/supervisor.sock`). */
  stackDir?: string
  publicHost: string
  publicIp: string
  timeoutMs: number
}

/** What the gate-user child created. Digests only: the canary values never leave that child. */
export type Canaries = {
  port: number
  keychainService: string
  keychainDigest: string
  /** A service name no item has: the add probe tries to create an item under it. */
  keychainAddService: string
  /** A canary item the gate user created: the modify probe tries to overwrite it. */
  keychainModifyService: string
  canaryDb: string
  dbDigest: string
}

/** The regular files in the stack run dir, outside the supervisor dir, for the gate user to try. */
export type StackFiles = string[]

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
  paths?: string[]
  /** The probe broker's socket: where a broker probe sends its job. */
  socket?: string
}

export type LiveRunner = {
  setup: () => Promise<Canaries>
  probe: (role: Role, spec: ProbeSpec) => Promise<ProbeResult>
  /**
   * Root side, `--stack-dir` only: puts a canary file in the run dir, so a file created there is
   * tested even when the run dir is otherwise empty, and lists every regular file outside the
   * supervisor dir. `teardown` removes the canary.
   */
  stackFiles: (stackDir: string) => Promise<StackFiles>
  /**
   * Starts the probe broker as the parser user and returns its socket. `teardown` stops it and
   * removes the socket. A broker that does not start rejects, and only the parser probes are
   * skipped.
   */
  startParserBroker: () => Promise<{ socket: string }>
  /** Connections the canary listener has accepted so far. */
  connections: () => Promise<number>
  teardown: () => Promise<void>
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
  "--parser-socket": "parserSocket",
  "--data-db": "dataDb",
  "--data-profile": "dataProfile",
  "--stack-dir": "stackDir",
  "--public-host": "publicHost",
  "--public-ip": "publicIp",
} as const

/** Flags the run works without. */
const OPTIONAL_STRING_KEYS: readonly string[] = ["dataProfile", "stackDir"]

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
  "parserSocket",
  "dataDb",
  "dataProfile",
  "stackDir",
] as const

const USER_NAME = /^[a-z_][a-z0-9_.-]{0,31}$/

export const USAGE =
  "usage: sudo node scripts/check-isolation-live.ts --gate-user <user> --data-user <user> " +
  "--intent-socket <path> --control-socket <path> --control-db <path> --gate-keychain <path> " +
  "--proxy-port <port> --llama-port <port> --parser-profile <path> --parser-socket <path> " +
  "--data-db <path> --public-host <hostname> --public-ip <IPv4> [--data-profile <path>] " +
  "[--stack-dir <path>] [--timeout-ms <ms>]"

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
    if (strings[key] === undefined && !OPTIONAL_STRING_KEYS.includes(key))
      errors.push(`${flag} is required`)
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
    parserSocket,
    dataDb,
    dataProfile,
    stackDir,
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
    parserSocket === undefined ||
    dataDb === undefined ||
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
      parserSocket,
      dataDb,
      ...(dataProfile === undefined ? {} : { dataProfile }),
      ...(stackDir === undefined ? {} : { stackDir }),
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
  canaries: Canaries,
  stackFiles: StackFiles = []
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
    case "keychain-add":
      return {
        ...base,
        keychain: config.gateKeychain,
        service: canaries.keychainAddService,
      }
    case "keychain-modify":
      return {
        ...base,
        keychain: config.gateKeychain,
        service: canaries.keychainModifyService,
      }
    case "control-db":
      return { ...base, path: canaries.canaryDb, digest: canaries.dbDigest }
    case "control-socket":
      return { ...base, path: config.controlSocket }
    case "data-db":
    case "parser-data-db":
      return { ...base, path: config.dataDb }
    case "parser-socket":
      return { ...base, path: config.parserSocket }
    case "parser-loopback":
      return { ...base, host: "127.0.0.1", port: canaries.port }
    case "parser-proxy":
      return { ...base, host: "127.0.0.1", port: config.proxyPort }
    case "parser-llama":
      return { ...base, host: "127.0.0.1", port: config.llamaPort }
    case "parser-intent-socket":
      return { ...base, path: config.intentSocket }
    // Without --stack-dir the spec lacks its target and runProbe reports BAD_SPEC; runLive never
    // gets there, it skips these two probes.
    case "supervisor-socket":
      return config.stackDir === undefined
        ? base
        : { ...base, path: stackPaths(config.stackDir).socket }
    case "run-dir-files":
      return { ...base, paths: stackFiles }
  }
}

// ---- the stack run dir (#70) ---------------------------------------------------------------------

/** Where the supervisor socket sits below the owner's stack dir (`infra/stack/config.ts`). */
export function stackPaths(stackDir: string): {
  runDir: string
  supervisorDir: string
  socket: string
} {
  const runDir = join(stackDir, "run")
  const supervisorDir = join(runDir, SUPERVISOR_DIR_NAME)
  return {
    runDir,
    supervisorDir,
    socket: join(supervisorDir, SUPERVISOR_SOCKET_NAME),
  }
}

/**
 * Every regular file below the run dir, outside the supervisor dir. Sockets and links are left out:
 * opening a socket fails whatever its permissions, so it would not show a denial.
 */
export function listRunDirFiles(stackDir: string): StackFiles {
  const { runDir, supervisorDir } = stackPaths(stackDir)
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (path === supervisorDir) continue
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  walk(runDir)
  return files
}

/**
 * Creates `.eido-isolation-canary-<random>` in the run dir, mode 0600 and owned like the run dir,
 * as a file the stack writes there would be. The gate user must be refused it: a file created in
 * the run dir after the ACLs are applied must not inherit an entry for the gate user. Returns the
 * path and a remover.
 */
export function createRunDirCanary(
  stackDir: string,
  random: (bytes: number) => Buffer = randomBytes
): { path: string; remove: () => void } {
  const { runDir } = stackPaths(stackDir)
  const path = join(
    runDir,
    `.eido-isolation-canary-${random(8).toString("hex")}`
  )
  const { uid, gid } = statSync(runDir)
  writeFileSync(path, random(64), { flag: "wx", mode: 0o600 })
  try {
    chmodSync(path, 0o600)
    chownSync(path, uid, gid)
  } catch (error) {
    rmSync(path, { force: true })
    throw error
  }
  return { path, remove: () => rmSync(path, { force: true }) }
}

/** One output line for one probe run. `newConnections` is the canary listener's count change. */
export function judge(
  def: ProbeDef,
  role: Role,
  result: ProbeResult,
  newConnections: number,
  witnessReached: boolean | undefined = undefined
): string {
  const label =
    role === "data" || def.subject === "gate" ? def.name : `${def.name}.control`
  const code = safeCode(result.code)
  if (!result.ran) return `FAIL ${label}: the probe did not run (${code})`
  if (def.subject === "gate") {
    if (def.data === "allowed")
      return result.reached
        ? `PASS ${label}`
        : `FAIL ${label}: the gate user cannot reach it (${code})`
    if (result.reached) return `FAIL ${label}: reached as the gate user`
    if (def.permission && !PERMISSION_CODES.has(code))
      return `FAIL ${label}: refused with ${code}, not permission denied`
    return `PASS ${label} (${code})`
  }
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
  if (result.reached)
    return `FAIL ${label}: reached ${def.via === "broker" ? "from the parse child" : "as the data-plane user"}`
  if (def.canaryListener && newConnections > 0)
    return `FAIL ${label}: the canary listener saw ${String(newConnections)} connection(s)`
  if (def.permission && !PERMISSION_CODES.has(code))
    return `FAIL ${label}: refused with ${code}, not permission denied`
  // A refusal only shows the fence when the target can be reached at all: the witness did it.
  if (def.witness !== undefined && witnessReached !== true)
    return `FAIL ${label}: ${def.witness.probe} did not reach the target as the ${def.witness.role === "gate" ? "gate" : "data-plane"} user (${code}), so the probe proves nothing`
  return `PASS ${label} (${code})`
}

/** The result a probe's witness must have had: it ran and reached. */
export function witnessHeld(
  def: ProbeDef,
  seen: ReadonlyMap<string, ProbeResult>
): boolean | undefined {
  if (def.witness === undefined) return undefined
  const result = seen.get(witnessKey(def.witness.probe, def.witness.role))
  return result !== undefined && result.ran && result.reached
}

function witnessKey(name: ProbeName, role: Role): string {
  return `${name}/${role}`
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
    let stackFiles: StackFiles | undefined
    if (canaries !== undefined && config.stackDir !== undefined) {
      try {
        stackFiles = await runner.stackFiles(config.stackDir)
      } catch (error) {
        report(
          `FAIL run-dir-files: the run dir could not be read or given a canary (${safeCode(error)})`
        )
      }
    }
    if (canaries !== undefined) {
      const seen = new Map<string, ProbeResult>()
      let broker: { socket: string } | undefined
      let brokerFailed = false
      for (const def of PROBES) {
        if (def.subject === "gate" && config.stackDir === undefined) {
          print(`SKIP ${def.name}: no --stack-dir given`)
          continue
        }
        if (def.name === "run-dir-files" && stackFiles === undefined) continue
        if (def.via === "broker" && broker === undefined) {
          if (!brokerFailed) {
            try {
              broker = await runner.startParserBroker()
            } catch (error) {
              brokerFailed = true
              report(
                `FAIL parser-broker: the probe broker did not start (${safeCode(error)})`
              )
            }
          }
          if (broker === undefined) {
            print(`SKIP ${def.name}: the probe broker did not start`)
            continue
          }
        }
        const base = probeSpec(def.name, config, canaries, stackFiles)
        const spec: ProbeSpec =
          def.via === "broker" && broker !== undefined
            ? { ...base, socket: broker.socket }
            : base
        for (const role of def.subject === "gate"
          ? (["gate"] as const)
          : def.control
            ? (["data", "gate"] as const)
            : (["data"] as const)) {
          const before = def.canaryListener ? await runner.connections() : 0
          const result = await attempt(role, spec)
          const after = def.canaryListener ? await runner.connections() : 0
          seen.set(witnessKey(def.name, role), result)
          report(
            judge(def, role, result, after - before, witnessHeld(def, seen))
          )
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

/** What `security` exits with when an item is not there (errSecItemNotFound). */
const SECURITY_ITEM_NOT_FOUND = "SECURITY_EXIT_44"

/**
 * Creates the listener, the Keychain read canary, the control DB canary and the Keychain modify
 * canary, in that order. If a step fails, the steps already done are undone before the error is
 * rethrown. The add probe has no item to create, but its service name is cleaned up all the same:
 * a probe that wrongly succeeded, or the gate control, leaves an item under it.
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
    const addService = `${service}-add`
    undo.push([
      "keychain-add",
      () => {
        try {
          host.deleteKeychainItem(spec.gateKeychain, addService)
        } catch (error) {
          if (safeCode(error) !== SECURITY_ITEM_NOT_FOUND) throw error
        }
      },
    ])
    const modifyService = `${service}-modify`
    host.addKeychainItem(
      spec.gateKeychain,
      modifyService,
      host.random(32).toString("hex")
    )
    undo.push([
      "keychain-modify",
      () => host.deleteKeychainItem(spec.gateKeychain, modifyService),
    ])
    return {
      canaries: {
        port: listener.port,
        keychainService: service,
        keychainDigest: sha256(secret),
        keychainAddService: addService,
        keychainModifyService: modifyService,
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
const NO_NETWORK = join(
  REPO,
  "packages",
  "core",
  "src",
  "parsers",
  "no-network.ts"
)
const BROKER_CLIENT = join(
  REPO,
  "packages",
  "core",
  "src",
  "parsers",
  "broker-client.ts"
)
const PROBE_BROKER = join(REPO, "scripts", "isolation-parser-broker.ts")
const PROBE_WORKER = join(REPO, "scripts", "isolation-parser-child.ts")

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

/**
 * Opens each file for reading. Reached means one could be opened. Otherwise the code is the first
 * refusal that was not permission denied (a missing file, say), else the first permission code, so
 * a path that does not exist cannot pass for a denial. An empty list proves nothing: not run.
 */
export function openFiles(
  paths: readonly string[],
  open: (path: string) => void = (path) => closeSync(openSync(path, "r"))
): ProbeResult {
  if (paths.length === 0) return { ran: false, code: "NO_FILES" }
  const codes: string[] = []
  for (const path of paths) {
    try {
      open(path)
      return { ran: true, reached: true, code: "OK" }
    } catch (error) {
      codes.push(safeCode(error))
    }
  }
  const other = codes.find((code) => !PERMISSION_CODES.has(code))
  return { ran: true, reached: false, code: other ?? codes[0] ?? "error" }
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

const WRITE_SERVICE = {
  add: /^eido-isolation-canary-[0-9a-f]{16}-add$/,
  modify: /^eido-isolation-canary-[0-9a-f]{16}-modify$/,
} as const

/**
 * Tries to write one Keychain item: `add` creates an item under a service name no item has,
 * `modify` overwrites (`-U`) the canary item the gate user made. Reached means `security` exited 0.
 * It only ever touches a service name this script generated, so a bad spec cannot reach a real
 * item. The value written is random and never printed; it is on this child's argv for the call.
 */
export function attemptKeychainWrite(
  mode: keyof typeof WRITE_SERVICE,
  keychain: string,
  service: string,
  run: (args: readonly string[]) => void = security,
  random: (bytes: number) => Buffer = randomBytes
): ProbeResult {
  if (!WRITE_SERVICE[mode].test(service))
    return { ran: false, code: "BAD_SERVICE" }
  try {
    run([
      "add-generic-password",
      ...(mode === "modify" ? ["-U"] : []),
      "-a",
      service,
      "-s",
      service,
      "-w",
      random(32).toString("hex"),
      keychain,
    ])
  } catch (error) {
    return { ran: true, reached: false, code: safeCode(error) }
  }
  return { ran: true, reached: true, code: "OK" }
}

/**
 * Sends one probe parse job to the probe broker (#820) and classifies what comes back. The job is
 * delivered the way core delivers a document: `createBrokerClient` over the broker's socket. The
 * parse child, a process of the probe broker running as the parser user, tries the target.
 */
async function reachFromParseChild(spec: ProbeSpec): Promise<ProbeResult> {
  const { name, socket } = spec
  if (!isParserProbeName(name) || socket === undefined)
    return { ran: false, code: "BAD_SPEC" }
  const target = parserTargetOf(name, {
    ...(spec.host === undefined ? {} : { host: spec.host }),
    ...(spec.port === undefined ? {} : { port: spec.port }),
    ...(spec.path === undefined ? {} : { path: spec.path }),
    timeoutMs: spec.timeoutMs,
  })
  if (target === undefined) return { ran: false, code: "BAD_SPEC" }
  const client = (await loadBrokerClient())({
    socketPath: socket,
    deadlineMs: spec.timeoutMs * 20,
  })
  const answer = await client.parseBytes(
    parserProbeDocument(target),
    PARSER_PROBE_MIME
  )
  return classifyParserAnswer(answer, target)
}

/**
 * Core's broker client, loaded by file URL: core's sources import each other without extensions,
 * which only the core hooks resolve, and the probe child that sends a job is started with them.
 * The run, the canary holder and the usage text never load it.
 */
async function loadBrokerClient(): Promise<typeof CreateBrokerClient> {
  // Our own checked-in module, loaded by path: the cast only restores the type the dynamic import
  // loses, no external input is involved.
  const loaded = (await import(pathToFileURL(BROKER_CLIENT).href)) as {
    createBrokerClient: typeof CreateBrokerClient
  }
  return loaded.createBrokerClient
}

/** Runs one probe in this process, as whoever this process is. */
export async function runProbe(spec: ProbeSpec): Promise<ProbeResult> {
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
    case "parser-socket":
      return spec.path === undefined
        ? missing
        : await reachUnixSocket(spec.path, spec.timeoutMs)
    case "supervisor-socket":
      return spec.path === undefined
        ? missing
        : await reachUnixSocket(spec.path, spec.timeoutMs)
    case "run-dir-files":
      return spec.paths === undefined ? missing : openFiles(spec.paths)
    case "keychain": {
      const { keychain, service, digest } = spec
      return keychain === undefined ||
        service === undefined ||
        digest === undefined
        ? missing
        : readMatches(() => readKeychain(keychain, service), digest)
    }
    case "keychain-add":
    case "keychain-modify": {
      const { keychain, service } = spec
      return keychain === undefined || service === undefined
        ? missing
        : attemptKeychainWrite(
            spec.name === "keychain-add" ? "add" : "modify",
            keychain,
            service
          )
    }
    case "control-db": {
      const { path, digest } = spec
      return path === undefined || digest === undefined
        ? missing
        : readMatches(() => readFileSync(path), digest)
    }
    case "data-db":
      return spec.path === undefined ? missing : openFiles([spec.path])
    case "parser-loopback":
    case "parser-proxy":
    case "parser-llama":
    case "parser-intent-socket":
    case "parser-data-db":
      return await reachFromParseChild(spec)
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
    "socket",
  ] as const) {
    const v = field(key)
    if (typeof v === "string") spec[key] = v
    else if (v !== undefined) return undefined
  }
  const port = field("port")
  if (typeof port === "number") spec.port = port
  else if (port !== undefined) return undefined
  const paths = field("paths")
  if (
    Array.isArray(paths) &&
    paths.every((path: unknown) => typeof path === "string")
  )
    spec.paths = paths
  else if (paths !== undefined) return undefined
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

const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

function sudoArgs(user: string, command: readonly string[]): string[] {
  return ["-n", "-u", user, "--", ...command]
}

/** The command for one script child: this script under Node, with `args`. */
function selfCommand(
  args: readonly string[],
  nodeFlags: readonly string[] = []
): string[] {
  return [process.execPath, ...nodeFlags, SELF, ...args]
}

/**
 * The `sudo` arguments that start one probe child. A data-plane probe starts under
 * `sandbox-exec -f <data profile>` when one is configured, as the data plane runs: name
 * resolution goes through mDNSResponder, which per-user pf cannot block, so only the sandbox
 * denies it. Gate-user controls are never sandboxed. A broker probe is not either: it only
 * delivers a job to the probe broker, loading core's broker client with the core hooks as core
 * does, and what it proves is the fence around the parse child, which the broker's own sandbox
 * (`parser.sb`) and the parser user's pf rules draw. No probe child is wrapped in `parser.sb` here.
 */
export function probeSudoArgs(
  role: Role,
  spec: ProbeSpec,
  config: LiveConfig
): string[] {
  const viaBroker = isParserProbeName(spec.name)
  const profile = role === "data" && !viaBroker ? config.dataProfile : undefined
  const probe = [
    "probe",
    "--spec",
    JSON.stringify(spec),
    ...(role === "gate" ? ["--as-gate"] : []),
  ]
  return sudoArgs(role === "gate" ? config.gateUser : config.dataUser, [
    ...(profile === undefined ? [] : [SANDBOX_EXEC, "-f", profile]),
    ...(viaBroker
      ? selfCommand(probe, [
          "--disable-warning=ExperimentalWarning",
          "--import",
          CORE_HOOKS,
        ])
      : selfCommand(probe)),
  ])
}

function sudoRunner(config: LiveConfig): LiveRunner {
  const holder = spawn(
    "sudo",
    sudoArgs(
      config.gateUser,
      selfCommand([
        "canaries",
        "--gate-user",
        config.gateUser,
        "--control-db",
        config.controlDb,
        "--gate-keychain",
        config.gateKeychain,
      ])
    ),
    { cwd: "/", stdio: ["pipe", "pipe", "inherit"] }
  )
  const exited = new Promise<number | null>((resolve) =>
    holder.once("close", resolve)
  )
  // The run dir canary is made by this root process, so it is removed here, on exit and on Ctrl-C.
  let runDirCanary: { path: string; remove: () => void } | undefined
  const removeRunDirCanary = () => {
    try {
      runDirCanary?.remove()
      runDirCanary = undefined
    } catch {
      // teardown reports a canary that is still there
    }
  }
  process.once("SIGINT", () => {
    removeRunDirCanary()
    process.exit(130)
  })
  // The probe broker stops when its stdin ends; the socket file is removed here as a backstop.
  let broker: ChildProcessByStdio<Writable, Readable, null> | undefined
  let brokerSocket: string | undefined
  let brokerExited: Promise<void> | undefined
  const stopBroker = async () => {
    broker?.stdin.end()
    const exitedInTime = await Promise.race([
      brokerExited?.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), config.timeoutMs * 10).unref()
      ),
    ])
    if (exitedInTime !== true) broker?.kill("SIGTERM")
    if (brokerSocket !== undefined) rmSync(brokerSocket, { force: true })
  }
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
      const keychainAddService = field(ready, "keychainAddService")
      const keychainModifyService = field(ready, "keychainModifyService")
      const canaryDb = field(ready, "canaryDb")
      const dbDigest = field(ready, "dbDigest")
      if (
        field(ready, "ready") !== true ||
        typeof port !== "number" ||
        typeof keychainService !== "string" ||
        typeof keychainDigest !== "string" ||
        typeof keychainAddService !== "string" ||
        typeof keychainModifyService !== "string" ||
        typeof canaryDb !== "string" ||
        typeof dbDigest !== "string"
      )
        throw Object.assign(new Error("no canaries"), {
          code: safeCode(field(ready, "code")),
        })
      return {
        port,
        keychainService,
        keychainDigest,
        keychainAddService,
        keychainModifyService,
        canaryDb,
        dbDigest,
      }
    },
    stackFiles: (stackDir) => {
      const files = listRunDirFiles(stackDir)
      runDirCanary = createRunDirCanary(stackDir)
      return Promise.resolve([...files, runDirCanary.path])
    },
    startParserBroker: async () => {
      const built = buildParserPlan({
        daemonProfile: readFileSync(config.parserProfile, "utf8"),
        daemonSocket: config.parserSocket,
        node: process.execPath,
        coreHooks: CORE_HOOKS,
        noNetwork: NO_NETWORK,
        brokerEntry: PROBE_BROKER,
        workerEntry: PROBE_WORKER,
        id: randomBytes(8).toString("hex"),
      })
      if (!built.ok)
        throw Object.assign(new Error(built.error), { code: "BAD_PLAN" })
      const { plan } = built
      broker = spawn("sudo", plan.brokerSudoArgs, {
        cwd: "/",
        stdio: ["pipe", "pipe", "inherit"],
      })
      brokerSocket = plan.socket
      const child = broker
      brokerExited = new Promise<void>((resolve) =>
        child.once("close", () => resolve())
      )
      const ready = await new Promise<unknown>((resolve) => {
        const timer = setTimeout(
          () => resolve(undefined),
          config.timeoutMs * 10
        )
        const lines = createInterface({ input: child.stdout })
        lines.once("line", (line) => {
          clearTimeout(timer)
          try {
            resolve(JSON.parse(line))
          } catch {
            resolve(undefined)
          }
        })
        void brokerExited?.then(() => {
          clearTimeout(timer)
          resolve(undefined)
        })
      })
      if (field(ready, "ready") !== true)
        throw Object.assign(new Error("the probe broker is not ready"), {
          code: "BROKER_NOT_READY",
        })
      return { socket: plan.socket }
    },
    connections: async () => {
      const reply = next()
      holder.stdin.write("count\n")
      return Number(field(await reply, "connections"))
    },
    probe: (role, spec) => {
      const run = spawnSync("sudo", probeSudoArgs(role, spec, config), {
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
      removeRunDirCanary()
      await stopBroker()
      holder.stdin.end()
      await exited
      if (runDirCanary !== undefined || field(last, "cleaned") !== true)
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
    process.stdout.write(`${JSON.stringify(await runProbe(spec))}\n`)
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
