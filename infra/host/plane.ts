// The plane split on macOS (#70): a gate user and a data-plane user, their directories and modes,
// the data plane's sandbox profile, the pf rules for the data-plane user, the LaunchDaemons that
// start each process under its own user, and the ACL that lets the gate user reach the owner's
// supervisor socket. The gate user's outbound allowlist (#471) is egress.ts, and the parser
// broker's user, sandbox and pf rules (#818) are parser-plane.ts, both wired in here.
// Pure functions: what to create and which commands create it. `plane-cli.ts` reads the host's
// state and prints the commands as a script the owner runs with sudo; nothing here touches the
// system.
import { parsePort } from "../tailscale/serve-routes.ts"
import {
  buildStackConfig,
  stackDirOf,
  SUPERVISOR_DIR_NAME,
  SUPERVISOR_SOCKET_NAME,
  type Env,
  type ProcessSpec,
} from "../stack/config.ts"
import {
  EGRESS_ANCHOR,
  EGRESS_REFRESH_SECONDS,
  egressHostList,
  egressJob,
  egressRules,
  type EgressTargets,
} from "./egress.ts"
import {
  gateLauncher,
  LAUNCHER_FILE,
  launchedGate,
  launcherSteps,
} from "./gate-launcher.ts"
import {
  DAEMON_DIR,
  daemonPlist,
  PLANE_LOGS,
  PLANE_ROOT,
  renderStep,
  sbplString,
  shellQuote,
  type DaemonSpec,
  type Step,
} from "./plane-base.ts"
import {
  PARSER_LABEL,
  PARSER_NAME,
  parserDirs,
  parserPaths,
  parserPfRules,
  parserProfile,
  parserRemovePaths,
  parserService,
  type ParserPaths,
} from "./parser-plane.ts"

export {
  DAEMON_DIR,
  daemonPlist,
  PLANE_LOGS,
  PLANE_ROOT,
  renderStep,
  shellQuote,
  type DaemonSpec,
  type Step,
}

/**
 * A child of the `com.apple/*` anchor point that the stock /etc/pf.conf already evaluates, so the
 * rules load without editing /etc/pf.conf and survive the macOS updates that rewrite it.
 */
export const PF_ANCHOR = "com.apple/eido.plane"

export const NAMES = {
  gate: "_eidogate",
  data: "_eidodata",
  /** The gate and data users are members; the gate's data-plane socket (0660) inherits it from the run dir. */
  ipc: "_eidoipc",
  /** The parser broker's user (#818): not in `_eidoipc`, no network. */
  parse: PARSER_NAME,
} as const

export const LABELS = {
  pf: "com.eido.plane.pf",
  egress: "com.eido.plane.egress",
  gate: "com.eido.plane.gate",
  core: "com.eido.plane.core",
  parser: PARSER_LABEL,
} as const

/** The first of four ids (gate uid/gid, data uid/gid, ipc gid, parse uid/gid): below 500, so the users stay hidden. */
export const DEFAULT_FIRST_ID = 451

/** How often the pf job reloads the anchor, in case something flushed it. */
export const PF_RELOAD_SECONDS = 300
const SERVICE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

export type PlaneLayout = {
  owner: string
  ownerHome: string
  ids: {
    gateUid: number
    dataUid: number
    gateGid: number
    dataGid: number
    ipcGid: number
    parseUid: number
    parseGid: number
  }
  root: string
  app: string
  /** The gate daemon's root launch step (#823), root-owned and read-only in the app copy. */
  gateLauncher: string
  gateDir: string
  dataDir: string
  runDir: string
  homeRoot: string
  gateHome: string
  dataHome: string
  keychainDir: string
  keychain: string
  policyDir: string
  coreProfile: string
  parserProfile: string
  pfRules: string
  /** The gate user's egress anchor and the hosts the egress job adds to its table (#471). */
  egressRules: string
  egressHosts: string
  logs: { root: string; gate: string; data: string; pf: string }
  gateSocket: string
  controlSocket: string
  /** The owner's stack run dir, below which the supervisor's socket directory sits (#644, #659). */
  ownerRunDir: string
  /** The supervisor's own directory (#783): the only place the gate user's inherited ACL entry goes. */
  supervisorDir: string
  supervisorSocket: string
  /** The parser broker's home, scratch, socket and logs (#818). */
  parser: ParserPaths
  plists: {
    pf: string
    egress: string
    gate: string
    parser: string
    core: string
  }
}

const USER_NAME = /^[a-z_][a-z0-9_.-]{0,31}$/

export function planeLayout(input: {
  owner: string
  ownerHome: string
  firstId: number
  /** The owner's environment: only `EIDO_STACK_DIR` is read, as the stack itself does. */
  env: Env
}): PlaneLayout {
  if (!USER_NAME.test(input.owner))
    throw new Error(`${JSON.stringify(input.owner)} is not a user name`)
  if (input.owner === "root" || input.owner.startsWith("_eido"))
    throw new Error(
      `the owner must be the person's own account, not ${input.owner}`
    )
  if (
    !Number.isInteger(input.firstId) ||
    input.firstId < 401 ||
    input.firstId > 496
  )
    throw new Error("--first-id must be between 401 and 496")
  const root = PLANE_ROOT
  const runDir = `${root}/run`
  const homeRoot = `${root}/home`
  const gateHome = `${homeRoot}/gate`
  const keychainDir = `${gateHome}/Library/Keychains/eido`
  const policyDir = `${root}/policy`
  const ownerRunDir = `${stackDirOf("darwin", input.env, input.ownerHome)}/run`
  const supervisorDir = `${ownerRunDir}/${SUPERVISOR_DIR_NAME}`
  if (!ownerRunDir.startsWith(`${input.ownerHome}/`))
    throw new Error(
      `the owner's stack dir must be inside ${input.ownerHome}: the supervisor socket ACL is granted from the home down`
    )
  const id = input.firstId
  return {
    owner: input.owner,
    ownerHome: input.ownerHome,
    ids: {
      gateUid: id,
      gateGid: id,
      dataUid: id + 1,
      dataGid: id + 1,
      ipcGid: id + 2,
      parseUid: id + 3,
      parseGid: id + 3,
    },
    root,
    app: `${root}/app`,
    gateLauncher: `${root}/app/${LAUNCHER_FILE}`,
    gateDir: `${root}/gate`,
    dataDir: `${root}/data`,
    runDir,
    homeRoot,
    gateHome,
    dataHome: `${homeRoot}/data`,
    keychainDir,
    keychain: `${keychainDir}/eido.keychain-db`,
    policyDir,
    coreProfile: `${policyDir}/core.sb`,
    parserProfile: `${policyDir}/parser.sb`,
    pfRules: `${policyDir}/eido-plane.pf`,
    egressRules: `${policyDir}/eido-egress.pf`,
    egressHosts: `${policyDir}/eido-egress.hosts`,
    logs: {
      root: PLANE_LOGS,
      gate: `${PLANE_LOGS}/gate`,
      data: `${PLANE_LOGS}/data`,
      pf: `${PLANE_LOGS}/pf`,
    },
    gateSocket: `${runDir}/gate-data-plane.sock`,
    controlSocket: `${runDir}/gate-control.sock`,
    ownerRunDir,
    supervisorDir,
    supervisorSocket: `${supervisorDir}/${SUPERVISOR_SOCKET_NAME}`,
    parser: parserPaths(root, homeRoot),
    plists: {
      pf: `${DAEMON_DIR}/${LABELS.pf}.plist`,
      egress: `${DAEMON_DIR}/${LABELS.egress}.plist`,
      gate: `${DAEMON_DIR}/${LABELS.gate}.plist`,
      parser: `${DAEMON_DIR}/${LABELS.parser}.plist`,
      core: `${DAEMON_DIR}/${LABELS.core}.plist`,
    },
  }
}

// ---- the host's accounts ---------------------------------------------------------------------

/** Name to id, from `dscl . -list /Users UniqueID` or `dscl . -list /Groups PrimaryGroupID`. */
export function parseDsclIds(stdout: string): Map<string, number> {
  const ids = new Map<string, number>()
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+(-?\d+)\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined)
      ids.set(match[1], Number(match[2]))
  }
  return ids
}

/** The value of one attribute from `dscl . -read <record> <attribute>`. */
export function parseDsclValue(stdout: string, attribute: string): string {
  const prefix = `${attribute}:`
  const lines = stdout.split("\n")
  const index = lines.findIndex((line) => line.startsWith(prefix))
  const inline = lines[index]?.slice(prefix.length).trim()
  // dscl puts a value with spaces on the next line, indented by one space.
  const value = inline === "" ? lines[index + 1]?.trim() : inline
  if (index === -1 || value === undefined || value === "")
    throw new Error(`dscl printed no ${attribute}`)
  return value
}

export type Accounts = {
  users: ReadonlyMap<string, number>
  groups: ReadonlyMap<string, number>
}

/**
 * Why the plane's ids cannot be used on this host: one of its names exists with another id, or
 * one of its ids belongs to another name. Empty when the plan may go ahead.
 */
export function accountProblems(
  layout: PlaneLayout,
  accounts: Accounts
): string[] {
  const problems: string[] = []
  const check = (
    kind: "user" | "group",
    existing: ReadonlyMap<string, number>,
    wanted: ReadonlyArray<readonly [string, number]>
  ) => {
    for (const [name, id] of wanted) {
      const has = existing.get(name)
      if (has !== undefined && has !== id)
        problems.push(
          `${kind} ${name} already exists with id ${String(has)}, not ${String(id)}; pass --first-id ${String(has)} or remove it first`
        )
      for (const [other, otherId] of existing)
        if (otherId === id && other !== name)
          problems.push(
            `${kind} id ${String(id)} belongs to ${other}; pass a free --first-id`
          )
    }
  }
  const { ids } = layout
  check("user", accounts.users, [
    [NAMES.gate, ids.gateUid],
    [NAMES.data, ids.dataUid],
    [NAMES.parse, ids.parseUid],
  ])
  check("group", accounts.groups, [
    [NAMES.gate, ids.gateGid],
    [NAMES.data, ids.dataGid],
    [NAMES.ipc, ids.ipcGid],
    [NAMES.parse, ids.parseGid],
  ])
  return problems
}

// ---- policy files ----------------------------------------------------------------------------

export type PlanePorts = {
  core: number
  /** llama-server on 127.0.0.1, when core is configured to use it. */
  llama?: number
  /** The gate's read egress proxy on 127.0.0.1, when a read connector is set up. */
  egress?: number
}

/**
 * The data plane's sandbox: core and every child it starts. No network but the gate's data-plane
 * socket, the parser broker's socket (#818), the egress proxy and llama-server on loopback, and
 * core's own loopback listener (which `tailscale serve` reaches). DNS goes through mDNSResponder's socket, so it is denied too. The
 * gate's directories are denied outright, on top of their modes.
 */
export function coreProfile(layout: PlaneLayout, ports: PlanePorts): string {
  const outbound = [ports.llama, ports.egress]
    .filter((port) => port !== undefined)
    .map(
      (port) =>
        `(allow network-outbound (remote ip ${sbplString(`localhost:${String(port)}`)}))`
    )
  return [
    "(version 1)",
    "; Eido data plane (#70): generated by `host plane`; edit the generator, not this file.",
    "(allow default)",
    "(deny network*)",
    `(allow network-outbound (remote unix-socket (path-literal ${sbplString(layout.gateSocket)})))`,
    `(allow network-outbound (remote unix-socket (path-literal ${sbplString(layout.parser.socket)})))`,
    ...outbound,
    `(allow network-bind network-inbound (local ip ${sbplString(`localhost:${String(ports.core)}`)}))`,
    `(deny file-read* file-write* (subpath ${sbplString(layout.gateDir)}) (subpath ${sbplString(layout.gateHome)}))`,
    "",
  ].join("\n")
}

export { parserProfile }

/**
 * The pf anchor: the data-plane user may open TCP to the egress proxy and llama-server on
 * 127.0.0.1 and nothing else, and may send no UDP. Rules match the numeric uid, so the file
 * parses before the user exists. The TCP block matches only a connection's first packet (SYN
 * without ACK): core's replies on connections others open to it (tailscale serve) carry ACK and
 * pass, since macOS's default ruleset keeps no state for them. The parser user's rules follow:
 * it may send or receive nothing (#818).
 */
export function pfAnchor(layout: PlaneLayout, ports: PlanePorts): string {
  const uid = String(layout.ids.dataUid)
  const allowed = [ports.egress, ports.llama]
    .filter((port) => port !== undefined)
    .map(String)
  const pass =
    allowed.length === 0
      ? []
      : [
          `pass out quick on lo0 inet proto tcp from any to 127.0.0.1 port { ${allowed.join(", ")} } user ${uid} flags S/SA keep state`,
        ]
  return [
    `# Eido plane split (#70), anchor ${PF_ANCHOR}: generated by \`host plane\`.`,
    `# uid ${uid} is ${NAMES.data}.`,
    ...pass,
    `block return out quick proto tcp from any to any user ${uid} flags S/SA`,
    `block return out quick proto udp from any to any user ${uid}`,
    ...parserPfRules(layout.ids.parseUid),
    "",
  ].join("\n")
}

// ---- LaunchDaemons ---------------------------------------------------------------------------

export type PlaneInput = {
  layout: PlaneLayout
  /** The owner's checkout; the plan copies it to the root-owned app dir. */
  checkout: string
  /** The node binary both services run; it must be readable by them, so not under /Users. */
  node: string
  tailnetHost: string
  /** stack.env with the owner's environment over it, as the stack reads it. */
  settings: Env
  egressPort?: number
  /** What the gate user may reach (#471), from the reviewed manifests: `egressTargets`. */
  allowlist: EgressTargets
}

/** Where a setting would point a service somewhere the plane does not allow. */
function checkSettings(settings: Env): void {
  const llamaHost = settings["EIDO_LLAMA_HOST"]
  if (
    llamaHost !== undefined &&
    llamaHost !== "127.0.0.1" &&
    llamaHost !== "localhost"
  )
    throw new Error(
      "EIDO_LLAMA_HOST must be 127.0.0.1 for the plane split: the pf rules allow llama-server on 127.0.0.1 only"
    )
}

function portOf(settings: Env, name: string): number | undefined {
  const value = settings[name]
  return value === undefined || value === ""
    ? undefined
    : parsePort(value, name)
}

export function planePorts(input: PlaneInput, core: ProcessSpec): PlanePorts {
  const llama = portOf(input.settings, "EIDO_LLAMA_PORT")
  return {
    core: core.port,
    ...(llama === undefined ? {} : { llama }),
    ...(input.egressPort === undefined ? {} : { egress: input.egressPort }),
  }
}

export type PlaneServices = {
  ports: PlanePorts
  gate: DaemonSpec
  /** The launcher script the gate daemon runs as root (#823). */
  launcher: string
  core: DaemonSpec
  pf: DaemonSpec
  egress: DaemonSpec
  parser: DaemonSpec
}

/**
 * The five LaunchDaemons. The gate and core get the stack's own settings (#374) with the plane's
 * directories and sockets over them, so one config decides both modes.
 */
export function planeServices(input: PlaneInput): PlaneServices {
  const { layout } = input
  if (input.node.startsWith("/Users/"))
    throw new Error(
      `node is at ${input.node}, inside a home the service users cannot read; install node outside /Users (for example with Homebrew) and pass --node`
    )
  checkSettings(input.settings)
  const config = buildStackConfig({
    mode: "prod",
    platform: "darwin",
    env: {
      ...input.settings,
      EIDO_GATE_DATA_DIR: layout.gateDir,
      EIDO_DATA_DIR: layout.dataDir,
      EIDO_GATE_SOCKET: layout.gateSocket,
      EIDO_GATE_CONTROL_SOCKET: layout.controlSocket,
      EIDO_GATE_KEYCHAIN_PATH: layout.keychain,
    },
    home: layout.ownerHome,
    repoRoot: layout.app,
    nodePath: input.node,
    tailnetHost: input.tailnetHost,
  })
  const spec = (name: "gate" | "core") => {
    const found = config.processes.find((p) => p.name === name)
    // buildStackConfig always returns gate, core and web.
    if (found === undefined) throw new Error(`no ${name} process`)
    return found
  }
  const gate = spec("gate")
  const core = spec("core")
  const ports = planePorts(input, core)
  const llama: Record<string, string> =
    ports.llama === undefined
      ? {}
      : { EIDO_LLAMA_HOST: "127.0.0.1", EIDO_LLAMA_PORT: String(ports.llama) }
  const egress =
    input.egressPort === undefined ? undefined : String(input.egressPort)
  return {
    ports,
    // launchd starts the launcher as root; it pipes the keychain passphrase to the gate's stdin and
    // drops to the gate user before it execs the gate, with the env and cwd below.
    gate: launchedGate(
      {
        label: LABELS.gate,
        user: NAMES.gate,
        group: NAMES.gate,
        args: [gate.command, ...gate.args],
        cwd: gate.cwd,
        env: {
          ...gate.env,
          ...(egress === undefined ? {} : { EIDO_GATE_EGRESS_PORT: egress }),
          HOME: layout.gateHome,
          PATH: SERVICE_PATH,
        },
        outLog: `${layout.logs.gate}/gate.out.log`,
        errLog: `${layout.logs.gate}/gate.err.log`,
        keepAlive: true,
      },
      layout.gateLauncher
    ),
    launcher: gateLauncher({
      user: NAMES.gate,
      groups: [NAMES.gate, NAMES.ipc],
      cwd: gate.cwd,
      argv: [gate.command, ...gate.args],
    }),
    core: {
      label: LABELS.core,
      user: NAMES.data,
      group: NAMES.data,
      args: [
        "/usr/bin/sandbox-exec",
        "-f",
        layout.coreProfile,
        core.command,
        ...core.args,
      ],
      cwd: core.cwd,
      env: {
        ...core.env,
        ...llama,
        ...(egress === undefined
          ? {}
          : { EIDO_GMAIL_PROXY_URL: `http://127.0.0.1:${egress}` }),
        EIDO_PARSER_SOCKET: layout.parser.socket,
        HOME: layout.dataHome,
        PATH: SERVICE_PATH,
      },
      outLog: `${layout.logs.data}/core.out.log`,
      errLog: `${layout.logs.data}/core.err.log`,
      keepAlive: true,
    },
    pf: {
      label: LABELS.pf,
      user: "root",
      group: "wheel",
      args: [
        "/bin/sh",
        "-c",
        `/sbin/pfctl -E; /sbin/pfctl -a ${PF_ANCHOR} -f ${shellQuote(layout.pfRules)}`,
      ],
      cwd: "/",
      env: { PATH: SERVICE_PATH },
      outLog: `${layout.logs.pf}/pf.out.log`,
      errLog: `${layout.logs.pf}/pf.err.log`,
      keepAlive: false,
      interval: PF_RELOAD_SECONDS,
    },
    // Runs only /bin/sh and /sbin/pfctl as root, reading root-owned files: nothing the owner or a
    // service user can write.
    egress: {
      label: LABELS.egress,
      user: "root",
      group: "wheel",
      args: [
        "/bin/sh",
        "-c",
        egressJob({ rules: layout.egressRules, hosts: layout.egressHosts }),
      ],
      cwd: "/",
      env: { PATH: SERVICE_PATH },
      outLog: `${layout.logs.pf}/egress.out.log`,
      errLog: `${layout.logs.pf}/egress.err.log`,
      keepAlive: false,
      interval: EGRESS_REFRESH_SECONDS,
    },
    parser: parserService({
      paths: layout.parser,
      profile: layout.parserProfile,
      app: layout.app,
      node: input.node,
      path: SERVICE_PATH,
    }),
  }
}

// ---- the commands ----------------------------------------------------------------------------

const DSCL = "/usr/bin/dscl"
const CHOWN = "/usr/sbin/chown"
const CHMOD = "/bin/chmod"
const FIND = "/usr/bin/find"
const LAUNCHCTL = "/bin/launchctl"
const PFCTL = "/sbin/pfctl"

const octal = (mode: number) => mode.toString(8).padStart(4, "0")

function dir(path: string, owner: string, group: string, mode: number): Step[] {
  return [
    { argv: ["/bin/mkdir", "-p", path] },
    { argv: [CHOWN, `${owner}:${group}`, path] },
    { argv: [CHMOD, octal(mode), path] },
  ]
}

/**
 * Takes back a log directory an earlier generator gave to a service user. Run after the
 * directory itself is root's, so its entries can no longer change. A symlink, a hard link or
 * anything else that is not a plain file may have been planted there and is removed; plain
 * files are made root's and readable by admins only.
 */
function rootOwnedLogs(path: string): Step[] {
  const entries = [FIND, path, "-mindepth", "1", "-maxdepth", "1"]
  return [
    {
      argv: [
        ...entries,
        "(",
        "!",
        "-type",
        "f",
        "-o",
        "-links",
        "+1",
        ")",
        "-exec",
        "/bin/rm",
        "-rf",
        "{}",
        "+",
      ],
    },
    {
      argv: [
        ...entries,
        "-type",
        "f",
        "-exec",
        CHOWN,
        "-h",
        "root:admin",
        "{}",
        "+",
        "-exec",
        CHMOD,
        "0640",
        "{}",
        "+",
      ],
    },
  ]
}

function file(path: string, content: string): Step[] {
  return [
    { argv: ["/usr/bin/tee", path], stdin: content },
    { argv: [CHOWN, "root:wheel", path] },
    { argv: [CHMOD, "0644", path] },
  ]
}

function group(name: string, gid: number, realName: string): Step[] {
  const record = `/Groups/${name}`
  return [
    { argv: [DSCL, ".", "-create", record] },
    { argv: [DSCL, ".", "-create", record, "PrimaryGroupID", String(gid)] },
    { argv: [DSCL, ".", "-create", record, "RealName", realName] },
    { argv: [DSCL, ".", "-create", record, "Password", "*"] },
  ]
}

function user(
  name: string,
  uid: number,
  gid: number,
  home: string,
  realName: string
): Step[] {
  const record = `/Users/${name}`
  const set = (key: string, value: string): Step => ({
    argv: [DSCL, ".", "-create", record, key, value],
  })
  return [
    { argv: [DSCL, ".", "-create", record] },
    set("UniqueID", String(uid)),
    set("PrimaryGroupID", String(gid)),
    set("UserShell", "/usr/bin/false"),
    set("NFSHomeDirectory", home),
    set("RealName", realName),
    // No password: nobody logs in as a service user. `*` is the locked-account marker.
    set("Password", "*"),
    set("IsHidden", "1"),
  ]
}

/** The directories from the owner's home down to the stack dir, above the run dir. */
export function supervisorAncestors(layout: PlaneLayout): string[] {
  const below = layout.ownerRunDir.slice(layout.ownerHome.length + 1).split("/")
  const dirs = [layout.ownerHome]
  for (const part of below.slice(0, -1))
    dirs.push(`${dirs[dirs.length - 1] ?? ""}/${part}`)
  return dirs
}

/**
 * The ACL entries that let the gate user, and nobody else, reach the supervisor socket. Mode
 * bits stay as the supervisor checks them (dirs 0700, socket 0600). The run dir and the
 * supervisor dir get `search` only. The inherited entry sits on the supervisor dir alone, so the
 * gate user's read and write reach files created in that dir afterwards (the socket, when the
 * supervisor next starts) and no other file in the stack's run dir (#783).
 */
export function supervisorAces(
  layout: PlaneLayout
): Array<{ path: string; ace: string }> {
  const search = `${NAMES.gate} allow search`
  return [
    ...supervisorAncestors(layout).map((path) => ({ path, ace: search })),
    { path: layout.ownerRunDir, ace: search },
    { path: layout.supervisorDir, ace: search },
    {
      path: layout.supervisorDir,
      ace: `${NAMES.gate} allow read,write,file_inherit,only_inherit`,
    },
  ]
}

/**
 * The entry an earlier generator put on the run dir itself, which every file created there
 * inherited. Apply and remove drop it (`chmod -a` fails when it is absent, so they tolerate that).
 */
function legacyRunDirAce(layout: PlaneLayout): { path: string; ace: string } {
  return {
    path: layout.ownerRunDir,
    ace: `${NAMES.gate} allow read,write,file_inherit,only_inherit`,
  }
}

/**
 * The daemons in start order: pf rules first, then the gate's egress table, then the services,
 * the parser broker before core, which connects to it.
 */
const DAEMONS = ["pf", "egress", "gate", "parser", "core"] as const

/** Every command that creates or updates the plane. Running it twice gives the same host. */
export function applySteps(input: PlaneInput): Step[] {
  const { layout } = input
  const { ids } = layout
  const services = planeServices(input)
  const { gate, data, ipc, parse } = NAMES
  // Build output, and local files the services must not read: secrets, env files (the committed
  // examples are kept), local eval output and databases. rsync applies the first match, so the
  // include comes before the exclude it overrides.
  const appFilters = [
    "--exclude=/.git",
    "--exclude=.turbo",
    "--exclude=/apps/web/.next",
    "--exclude=coverage",
    "--exclude=/infra/secrets",
    "--include=.env.example",
    "--exclude=.env*",
    "--exclude=/eval-local",
    "--exclude=*.db",
    "--exclude=*.db-wal",
    "--exclude=*.db-shm",
    // Written below, never copied from the checkout or deleted by --delete (#823).
    `--exclude=/${LAUNCHER_FILE}`,
  ]
  return [
    ...group(gate, ids.gateGid, "Eido gate"),
    ...group(data, ids.dataGid, "Eido data plane"),
    ...group(ipc, ids.ipcGid, "Eido gate data-plane socket"),
    ...group(parse, ids.parseGid, "Eido document parsers"),
    ...user(gate, ids.gateUid, ids.gateGid, layout.gateHome, "Eido gate"),
    ...user(data, ids.dataUid, ids.dataGid, layout.dataHome, "Eido data plane"),
    ...user(
      parse,
      ids.parseUid,
      ids.parseGid,
      layout.parser.home,
      "Eido document parsers"
    ),
    // Sets the member list outright, so a second run leaves exactly these two: never the parser.
    {
      argv: [
        DSCL,
        ".",
        "-create",
        `/Groups/${ipc}`,
        "GroupMembership",
        gate,
        data,
      ],
    },
    ...dir(layout.root, "root", "wheel", 0o755),
    ...dir(layout.homeRoot, "root", "wheel", 0o755),
    ...dir(layout.gateHome, gate, gate, 0o700),
    ...dir(`${layout.gateHome}/Library`, gate, gate, 0o700),
    ...dir(`${layout.gateHome}/Library/Keychains`, gate, gate, 0o700),
    ...dir(layout.keychainDir, gate, gate, 0o700),
    ...dir(layout.dataHome, data, data, 0o700),
    ...dir(layout.gateDir, gate, gate, 0o700),
    ...dir(layout.dataDir, data, data, 0o700),
    ...dir(layout.runDir, gate, ipc, 0o750),
    ...dir(layout.policyDir, "root", "wheel", 0o755),
    ...dir(layout.app, "root", "wheel", 0o755),
    ...dir(layout.logs.root, "root", "wheel", 0o755),
    // Root's, not the gate's: launchd opens the gate's logs as root (#823), so a gate that could
    // swap one for a link would get root appending to any file. The gate writes them only
    // through the descriptors launchd hands it.
    ...dir(layout.logs.gate, "root", "admin", 0o750),
    ...rootOwnedLogs(layout.logs.gate),
    ...dir(layout.logs.data, data, "admin", 0o750),
    ...dir(layout.logs.pf, "root", "wheel", 0o755),
    ...parserDirs(layout.parser, data).flatMap((d) =>
      dir(d.path, d.owner, d.group, d.mode)
    ),
    {
      argv: [
        "/usr/bin/rsync",
        "-a",
        "--delete",
        ...appFilters,
        `${input.checkout}/`,
        `${layout.app}/`,
      ],
    },
    { argv: [CHOWN, "-R", "root:wheel", layout.app] },
    { argv: [CHMOD, "-R", "go-w", layout.app] },
    // After the copy, so `rsync --delete` cannot take it back before the gate starts.
    ...launcherSteps(layout.gateLauncher, services.launcher),
    ...file(layout.coreProfile, coreProfile(layout, services.ports)),
    ...file(layout.parserProfile, parserProfile(layout.parser)),
    ...file(layout.pfRules, pfAnchor(layout, services.ports)),
    {
      argv: [
        "/usr/bin/sandbox-exec",
        "-f",
        layout.coreProfile,
        "/usr/bin/true",
      ],
    },
    {
      argv: [
        "/usr/bin/sandbox-exec",
        "-f",
        layout.parserProfile,
        "/usr/bin/true",
      ],
    },
    { argv: [PFCTL, "-a", PF_ANCHOR, "-nf", layout.pfRules] },
    ...file(
      layout.egressRules,
      egressRules({ uid: ids.gateUid, local: input.allowlist.local })
    ),
    ...file(layout.egressHosts, egressHostList(input.allowlist.hosts)),
    { argv: [PFCTL, "-a", EGRESS_ANCHOR, "-nf", layout.egressRules] },
    // Loads the new rules now; the egress job only loads them into an empty anchor. This empties
    // the table until the job, started below, adds the hosts again.
    { argv: [PFCTL, "-a", EGRESS_ANCHOR, "-f", layout.egressRules] },
    // The supervisor's own directory, owned by the owner at 0700, as the supervisor checks it. The
    // run dir must exist already (the stack creates it): `install -d` would otherwise create it
    // here as root.
    { argv: ["/bin/test", "-d", layout.ownerRunDir] },
    {
      argv: [
        "/usr/bin/install",
        "-d",
        "-o",
        layout.owner,
        "-m",
        "0700",
        layout.supervisorDir,
      ],
    },
    {
      argv: [
        CHMOD,
        "-a",
        legacyRunDirAce(layout).ace,
        legacyRunDirAce(layout).path,
      ],
      mayFail: true,
    },
    ...supervisorAces(layout).map(({ path, ace }) => ({
      argv: [CHMOD, "+a", ace, path],
    })),
    ...DAEMONS.flatMap((name) => [
      ...file(layout.plists[name], daemonPlist(services[name])),
      { argv: ["/usr/bin/plutil", "-lint", layout.plists[name]] },
    ]),
    ...DAEMONS.flatMap((name) => [
      { argv: [LAUNCHCTL, "bootout", `system/${LABELS[name]}`], mayFail: true },
      { argv: [LAUNCHCTL, "bootstrap", "system", layout.plists[name]] },
    ]),
  ]
}

/**
 * Every command that takes the plane down: the daemons, the pf anchor, the ACL entries, the
 * users and groups, the policy files and the app copy. The gate's and data plane's directories
 * and their logs are kept; `removeNotes` says where they are. The parser holds nothing to keep
 * (documents in flight only), so its directories and logs go with its user.
 */
export function removeSteps(layout: PlaneLayout, accounts: Accounts): Step[] {
  const { gate, data, ipc, parse } = NAMES
  return [
    ...[...DAEMONS].reverse().flatMap((name) => [
      {
        argv: [LAUNCHCTL, "bootout", `system/${LABELS[name]}`],
        mayFail: true,
      },
      { argv: ["/bin/rm", "-f", layout.plists[name]] },
    ]),
    { argv: ["/bin/rm", "-f", layout.gateLauncher] },
    { argv: [PFCTL, "-a", PF_ANCHOR, "-F", "all"], mayFail: true },
    { argv: [PFCTL, "-a", EGRESS_ANCHOR, "-F", "all"], mayFail: true },
    ...[...supervisorAces(layout), legacyRunDirAce(layout)].map(
      ({ path, ace }) => ({
        argv: [CHMOD, "-a", ace, path],
        mayFail: true,
      })
    ),
    ...[gate, data, parse]
      .filter((name) => accounts.users.has(name))
      .map((name) => ({ argv: [DSCL, ".", "-delete", `/Users/${name}`] })),
    ...[ipc, gate, data, parse]
      .filter((name) => accounts.groups.has(name))
      .map((name) => ({ argv: [DSCL, ".", "-delete", `/Groups/${name}`] })),
    { argv: ["/bin/rm", "-rf", layout.policyDir, layout.app, layout.runDir] },
    { argv: ["/bin/rm", "-rf", ...parserRemovePaths(layout.parser)] },
  ]
}

export function removeNotes(layout: PlaneLayout): string[] {
  return [
    "Kept: the gate's and data plane's data, the gate's keychain and the logs. Back them up, then delete them by hand:",
    `  sudo rm -rf ${shellQuote(layout.root)} ${shellQuote(layout.logs.root)}`,
  ]
}

export function renderScript(
  steps: readonly Step[],
  notes: readonly string[] = []
): string {
  return [
    "#!/bin/sh",
    "# Generated by `node infra/host/bin.ts plane`; review it, then run it with sudo (infra/plane-split.md).",
    "set -eu",
    ...steps.map(renderStep),
    ...notes.map((note) => `# ${note}`),
    "",
  ].join("\n")
}
