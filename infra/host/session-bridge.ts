// The session bridge's part of the host plane (#827, decided in #811): a login agent that runs
// `eido-helper --bridge` in the owner's own GUI session, so Things, EventKit and the file helper
// work for the gate, which runs as `_eidogate` outside that session. The bridge listens on a
// Unix socket in a directory the owner owns; only the gate user may connect, through an ACL
// entry that new files in that directory inherit (the bridge makes a fresh socket, mode 0600, on
// every start, so an entry on the socket itself would be lost). Pure functions that return text
// and `Step`s; `plane.ts` wires them in and nothing here touches the system.
import { escapeXml } from "../llama/launchd.ts"

import { asOwner, type Step } from "./plane-base.ts"

export const BRIDGE_LABEL = "com.eido.plane.bridge"
export const BRIDGE_SOCKET_DIR_NAME = "session-bridge"
export const BRIDGE_SOCKET_NAME = "bridge.sock"

/** `sizeof(sun_path)` on macOS, the terminating NUL included: a longer path cannot be bound. */
const SUN_PATH_BYTES = 104

/** The environment variables the gate reads to find the bridge (`packages/gate`, #892). */
export const BRIDGE_SOCKET_ENV = "EIDO_SESSION_BRIDGE_SOCKET"
export const BRIDGE_UID_ENV = "EIDO_SESSION_BRIDGE_UID"

const AGENT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
const THROTTLE_SECONDS = 10

const CHMOD = "/bin/chmod"
const INSTALL = "/usr/bin/install"
const LAUNCHCTL = "/bin/launchctl"
const RM = "/bin/rm"

export type BridgePaths = {
  /** Root-owned: the helper binaries the agent runs. Outside `app`, which rsync `--delete` rewrites. */
  dir: string
  helper: string
  fileHelper: string
  thingsScripts: string
  /** Owned by the owner at 0700, under the owner's stack run dir. */
  socketDir: string
  socket: string
  plistDir: string
  plist: string
  /** The owner's private log directory, shared with the stack's own agent. */
  logDir: string
  outLog: string
  errLog: string
}

export function bridgePaths(input: {
  root: string
  app: string
  ownerHome: string
  ownerRunDir: string
}): BridgePaths {
  const dir = `${input.root}/bridge`
  const socketDir = `${input.ownerRunDir}/${BRIDGE_SOCKET_DIR_NAME}`
  const plistDir = `${input.ownerHome}/Library/LaunchAgents`
  const logDir = `${input.ownerHome}/Library/Logs/eido-dev`
  return {
    dir,
    helper: `${dir}/eido-helper`,
    fileHelper: `${dir}/eido-file-helper`,
    thingsScripts: `${input.app}/packages/gate/src/internal/things/scripts`,
    socketDir,
    socket: `${socketDir}/${BRIDGE_SOCKET_NAME}`,
    plistDir,
    plist: `${plistDir}/${BRIDGE_LABEL}.plist`,
    logDir,
    outLog: `${logDir}/bridge.out.log`,
    errLog: `${logDir}/bridge.err.log`,
  }
}

export type BridgeInput = {
  /** The owner's uid: the agent's launchd domain, and the uid the gate requires of the socket (#892). */
  ownerUid: number
  /** The owner's built `eido-helper`, copied to the root-owned bridge dir. */
  helper: string
  /** The owner's built `eido-file-helper`. May be a symlink such as `current`: the copy is a real file. */
  fileHelper: string
  /** The pin printed by `pnpm install:file-helper`, 64 lowercase hex digits. */
  fileHelperSha256: string
  /** The owner's own list of approved file roots (#865), passed as `--file-roots`. */
  fileRoots: string
}

const SHA256 = /^[0-9a-f]{64}$/

/** Throws on a bridge setting the helper would refuse to start with, before any script is printed. */
export function checkBridge(paths: BridgePaths, input: BridgeInput): void {
  if (!Number.isInteger(input.ownerUid) || input.ownerUid < 0)
    throw new Error("the bridge needs the owner's numeric user id")
  for (const [flag, path] of [
    ["--bridge-helper", input.helper],
    ["--bridge-file-helper", input.fileHelper],
    ["--bridge-file-roots", input.fileRoots],
  ] as const)
    if (!path.startsWith("/") || path.includes("\0"))
      throw new Error(
        `${flag} must be an absolute path, not ${JSON.stringify(path)}`
      )
  if (!SHA256.test(input.fileHelperSha256))
    throw new Error(
      "--bridge-file-helper-sha256 must be 64 lowercase hex digits, as `pnpm install:file-helper` prints it"
    )
  if (Buffer.byteLength(paths.socket) >= SUN_PATH_BYTES)
    throw new Error(
      `the bridge socket path ${paths.socket} is ${String(Buffer.byteLength(paths.socket))} bytes; a Unix socket path must be shorter than ${String(SUN_PATH_BYTES)}`
    )
}

/**
 * What launchd runs. The helper and the file helper are the root-owned copies. The list of file
 * roots is the owner's own file. The file helper's private copy directory is left to the
 * helper's default (the owner's per-user cache directory); see infra/plane-split.md.
 */
export function bridgeProgramArguments(
  paths: BridgePaths,
  input: BridgeInput,
  peerUser: string
): string[] {
  return [
    paths.helper,
    "--bridge",
    "--socket",
    paths.socket,
    "--peer-user",
    peerUser,
    "--things-scripts",
    paths.thingsScripts,
    "--file-helper",
    paths.fileHelper,
    "--file-helper-sha256",
    input.fileHelperSha256,
    "--file-roots",
    input.fileRoots,
  ]
}

const str = (value: string) => `<string>${escapeXml(value)}</string>`

/**
 * A login agent, not a daemon: `Aqua` limits it to the owner's graphical session, so it starts
 * at login and stops at logout, and it has no `UserName`, so it runs as the owner. The
 * environment holds `PATH` only.
 */
export function bridgePlist(
  paths: BridgePaths,
  input: BridgeInput,
  peerUser: string
): string {
  const args = bridgeProgramArguments(paths, input, peerUser)
    .map((arg) => `    ${str(arg)}`)
    .join("\n")
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${str(BRIDGE_LABEL)}`,
    "  <key>LimitLoadToSessionType</key>",
    `  ${str("Aqua")}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    ${str(AGENT_PATH)}`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    `  <integer>${String(THROTTLE_SECONDS)}</integer>`,
    "  <key>ProcessType</key>",
    "  <string>Standard</string>",
    "  <key>StandardOutPath</key>",
    `  ${str(paths.outLog)}`,
    "  <key>StandardErrorPath</key>",
    `  ${str(paths.errLog)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

export type Ace = { path: string; ace: string }

/**
 * The ACL entries that let the gate user, and nobody else, connect to the bridge's socket.
 * `searchPath` lists the directories above the socket dir, from the owner's home down to the
 * stack's run dir, which need `search` for the gate user to reach it. The socket dir gets
 * `search` and one entry that only its new files inherit, so the socket the bridge creates at
 * each start carries read and write for the gate user. Nothing grants write on a directory, so
 * no other principal gains write access to the socket dir (the gate refuses one that has).
 */
export function bridgeAces(
  paths: BridgePaths,
  gateUser: string,
  searchPath: readonly string[]
): Ace[] {
  const search = `${gateUser} allow search`
  return [
    ...searchPath.map((path) => ({ path, ace: search })),
    { path: paths.socketDir, ace: search },
    {
      path: paths.socketDir,
      ace: `${gateUser} allow read,write,file_inherit,only_inherit`,
    },
  ]
}

const sameAce = (a: Ace, b: Ace) => a.path === b.path && a.ace === b.ace

/** `aces` without the entries `already` holds: the same entry added twice would be listed twice. */
export function withoutAces(
  aces: readonly Ace[],
  already: readonly Ace[]
): Ace[] {
  return aces.filter((ace) => !already.some((held) => sameAce(held, ace)))
}

/**
 * Puts the helper and the file helper in a root-owned directory, as real files (the bridge opens
 * the file helper without following a symlink at its last component, #905), and checks the
 * file helper's copy against the pin before anything starts. `install` copies the content of a
 * symlinked source, so a `current` link as the source still yields a regular file.
 */
export function bridgeInstallSteps(
  paths: BridgePaths,
  input: BridgeInput
): Step[] {
  const copy = (source: string, dest: string): Step[] => [
    { argv: [RM, "-f", dest] },
    {
      argv: [INSTALL, "-o", "root", "-g", "wheel", "-m", "0755", source, dest],
    },
  ]
  return [
    {
      argv: [
        INSTALL,
        "-d",
        "-o",
        "root",
        "-g",
        "wheel",
        "-m",
        "0755",
        paths.dir,
      ],
    },
    ...copy(input.helper, paths.helper),
    ...copy(input.fileHelper, paths.fileHelper),
    {
      argv: [
        "/bin/sh",
        "-c",
        'test "$(/usr/bin/shasum -a 256 "$1" | /usr/bin/cut -d" " -f1)" = "$2" || { echo "the file helper copy does not match --bridge-file-helper-sha256" >&2; exit 1; }',
        "sh",
        paths.fileHelper,
        input.fileHelperSha256,
      ],
    },
  ]
}

/**
 * The owner's socket directory at 0700, then its ACL entries. The caller has already checked
 * that the run dir exists (`install -d` would create it as root otherwise).
 */
export function bridgeSocketDirSteps(
  paths: BridgePaths,
  owner: string,
  aces: readonly Ace[]
): Step[] {
  const steps: Step[] = [
    { argv: [INSTALL, "-d", "-m", "0700", paths.socketDir] },
    ...aces.map(({ path, ace }) => ({ argv: [CHMOD, "+a", ace, path] })),
  ]
  return steps.map((step) => asOwner(owner, step))
}

// Write and lint a fresh plist beside its destination before replacing it. On macOS
// mv -h replaces a link to a directory instead of moving the file through the link.
const WRITE_AGENT_PLIST = [
  'tmp=$(/usr/bin/mktemp "$1.XXXXXX")',
  "trap '/bin/rm -f \"$tmp\"' EXIT",
  '/bin/cat > "$tmp"',
  '/bin/chmod 0644 "$tmp"',
  '/usr/bin/plutil -lint "$tmp"',
  '/bin/mv -fh "$tmp" "$1"',
].join("\n")

/** Run all agent setup in the owner's account, after the daemons and ACLs are in place. */
export function bridgeAgentSteps(
  paths: BridgePaths,
  input: BridgeInput,
  owner: string,
  peerUser: string
): Step[] {
  const domain = `gui/${String(input.ownerUid)}`
  const steps: Step[] = [
    { argv: [INSTALL, "-d", "-m", "0755", paths.plistDir] },
    // The stack's own agent keeps logs here, private to the owner.
    { argv: [INSTALL, "-d", "-m", "0700", paths.logDir] },
    {
      argv: ["/bin/sh", "-eu", "-c", WRITE_AGENT_PLIST, "sh", paths.plist],
      stdin: bridgePlist(paths, input, peerUser),
    },
    {
      argv: [LAUNCHCTL, "bootout", `${domain}/${BRIDGE_LABEL}`],
      mayFail: true,
    },
    { argv: [LAUNCHCTL, "bootstrap", domain, paths.plist] },
  ]
  return steps.map((step) => asOwner(owner, step))
}

/** Stops the agent and deletes its plist and logs. Safe to run when the bridge was never applied. */
export function bridgeStopSteps(
  paths: BridgePaths,
  owner: string,
  ownerUid: number | undefined
): Step[] {
  const steps: Step[] = []
  if (ownerUid !== undefined)
    steps.push({
      argv: [LAUNCHCTL, "bootout", `gui/${String(ownerUid)}/${BRIDGE_LABEL}`],
      mayFail: true,
    })
  steps.push({ argv: [RM, "-f", paths.plist, paths.outLog, paths.errLog] })
  return steps.map((step) => asOwner(owner, step))
}

/** Remove the socket and helper directories after their ACL entries are gone. */
export function bridgeRemoveSteps(paths: BridgePaths, owner: string): Step[] {
  return [
    asOwner(owner, { argv: [RM, "-rf", paths.socketDir] }),
    { argv: [RM, "-rf", paths.dir] },
  ]
}
