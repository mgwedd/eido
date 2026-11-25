// The backup of a split host (#782, part of #70). Under the plane the databases live in
// `/Library/Application Support/Eido/gate` (`_eidogate`, 0700) and `.../data` (`_eidodata`, 0700),
// which the owner's nightly LaunchAgent cannot read. One root LaunchDaemon backs both up through
// the same pipeline as the single-user backup (staged `VACUUM INTO` copies, restic, retention,
// stamp), so the restore drill and `verifyRestored` work unchanged. Root alone holds the
// repository passphrase file and the staging directory, so neither service user can read the
// other's database, or either database from a snapshot.
//
// Pure, like `infra/host/plane.ts`: `planeBackup` says what to create and `renderPlaneBackup`
// prints it as a /bin/sh script for the owner to review and run with `sudo sh`. Nothing here
// touches the system.
import { posix } from "node:path"

import {
  DAEMON_DIR,
  PLANE_ROOT,
  daemonPlist,
  renderStep,
  shellQuote,
  type Step,
} from "../host/plane-base.ts"
import {
  KEYCHAIN,
  PLANE_BACKUP_DIR,
  PLANE_BACKUP_LOG_DIR,
  planeBackupConfig,
  type BackupConfig,
} from "./config.ts"
import { BackupError } from "./errors.ts"
import { SCHEDULE } from "./plist.ts"

export const PLANE_BACKUP_LABEL = "com.eido.plane.backup"
export const PLANE_BACKUP_PLIST = `${DAEMON_DIR}/${PLANE_BACKUP_LABEL}.plist`
/**
 * Runs every day at the single-user job's time (`SCHEDULE`), not at load: a daemon that runs at
 * boot starts before login, when a backup drive that mounts after login is still absent, and a
 * fixed interval restarts at every boot, so a Mac that reboots daily would never reach it. launchd
 * runs a calendar job missed during sleep when the Mac wakes; `check` allows 36 hours.
 */
export const PLANE_BACKUP_SCHEDULE = SCHEDULE
/** The daemon's whole PATH. restic and node are named by absolute path, so it finds nothing owner-writable. */
export const PLANE_BACKUP_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
/** Where the root-owned node and restic the daemon runs are installed (`infra/backup-restore.md`). */
export const PLANE_BIN = `${PLANE_ROOT}/bin`
export const PLANE_NODE = `${PLANE_BIN}/node`
export const PLANE_RESTIC = `${PLANE_BIN}/restic`
/** The plane's root-owned copy of the checkout (`planeLayout().app`): what the daemon runs. */
export const PLANE_APP = `${PLANE_ROOT}/app`
const BIN = `${PLANE_APP}/infra/backup/bin.ts`
const BACKUP_LOG = `${PLANE_BACKUP_LOG_DIR}/backup.log`

const CHOWN = "/usr/sbin/chown"
const CHMOD = "/bin/chmod"
const TOUCH = "/usr/bin/touch"

export type PlaneBackupInput = {
  /** The restic repository: an absolute local path on the backup drive. */
  repository: string
  /** The node binary the daemon runs as root: absolute, outside `/Users`, root-owned. */
  node: string
  /** The restic binary the daemon runs as root: the same rules as `node`. */
  restic: string
}

export type PlaneBackup = {
  config: BackupConfig
  plist: string
  steps: Step[]
  /** What the owner does before and after the script; printed as comments under it. */
  notes: string[]
}

/** A directory that exists with the given owner, group and mode (`mkdir -p` keeps existing contents). */
function dir(path: string, owner: string, group: string, mode: string): Step[] {
  return [
    { argv: ["/bin/mkdir", "-p", path] },
    { argv: [CHOWN, `${owner}:${group}`, path] },
    { argv: [CHMOD, mode, path] },
  ]
}

/** An empty file with the given owner and mode, left alone when it already holds something. */
function emptyFile(
  path: string,
  owner: string,
  group: string,
  mode: string
): Step[] {
  return [
    { argv: [TOUCH, path] },
    { argv: [CHOWN, `${owner}:${group}`, path] },
    { argv: [CHMOD, mode, path] },
  ]
}

/**
 * Fails the script, naming the file, unless the binary and its directory are owned by root and
 * not writable by group or others. The daemon runs it as root, so anything the owner can replace
 * would hand the owner root, and the plane split would mean nothing.
 */
function rootOwned(path: string): Step {
  const check =
    'for p in "$1" "${1%/*}"; do ' +
    '[ "$(/usr/bin/stat -f %u "$p")" = 0 ] && ' +
    '[ -z "$(/usr/bin/find "$p" -maxdepth 0 \\( -perm -g+w -o -perm -o+w \\))" ] || ' +
    '{ echo "$p must be owned by root and not writable by group or others (infra/backup-restore.md)" >&2; exit 1; }; done'
  return { argv: ["/bin/sh", "-c", check, "sh", path] }
}

const CONTROL = /[\u0000-\u001f\u007f]/

/** A value that reaches the script or the plist: absolute, no control characters, no newline. */
function absolutePath(what: string, value: string): string {
  if (CONTROL.test(value))
    throw new BackupError(
      `${what} contains a control character or newline: ${JSON.stringify(value)}`
    )
  if (!posix.isAbsolute(value))
    throw new BackupError(
      `${what} must be an absolute path, not ${JSON.stringify(value)}`
    )
  return value
}

/** A binary the root daemon runs: never from a home, which the owner can write. */
function rootBinary(what: string, value: string): string {
  absolutePath(what, value)
  if (value.startsWith("/Users/"))
    throw new BackupError(
      `${what} is at ${value}, inside a home the owner can write; install it outside /Users, root-owned (infra/backup-restore.md)`
    )
  return value
}

const pad = (n: number) => String(n).padStart(2, "0")

export function planeBackup(input: PlaneBackupInput): PlaneBackup {
  const node = rootBinary("the node binary", input.node)
  const restic = rootBinary("the restic binary", input.restic)
  absolutePath("the repository", input.repository)
  const config = planeBackupConfig(input.repository)
  const passwordFile = config.passwordFile ?? ""
  const plist = daemonPlist({
    label: PLANE_BACKUP_LABEL,
    user: "root",
    group: "wheel",
    args: [node, "--disable-warning=ExperimentalWarning", BIN, "run"],
    cwd: "/",
    env: {
      // restic's cache lands under HOME, inside the root-only backup directory.
      HOME: PLANE_BACKUP_DIR,
      PATH: PLANE_BACKUP_PATH,
      EIDO_RESTIC_BIN: restic,
      EIDO_BACKUP_PLANE: "split",
      EIDO_BACKUP_REPO: config.repository,
    },
    outLog: BACKUP_LOG,
    errLog: BACKUP_LOG,
    keepAlive: false,
    dailyAt: PLANE_BACKUP_SCHEDULE,
    runAtLoad: false,
  })
  const steps: Step[] = [
    // The script stops here on a host where the plane was never applied.
    ...config.databases.map((db) => ({
      argv: ["/bin/test", "-d", posix.dirname(db.path)],
    })),
    { argv: ["/bin/test", "-f", BIN] },
    // The daemon runs these as root.
    { argv: ["/bin/test", "-x", node] },
    rootOwned(node),
    { argv: ["/bin/test", "-x", restic] },
    rootOwned(restic),
    ...dir(PLANE_BACKUP_DIR, "root", "wheel", "0700"),
    // The owner is in `admin`, so the log is readable without sudo; it holds file names and
    // counts, no contents.
    ...dir(PLANE_BACKUP_LOG_DIR, "root", "admin", "0750"),
    ...emptyFile(BACKUP_LOG, "root", "admin", "0640"),
    ...emptyFile(passwordFile, "root", "wheel", "0600"),
    { argv: ["/usr/bin/tee", PLANE_BACKUP_PLIST], stdin: plist },
    { argv: [CHOWN, "root:wheel", PLANE_BACKUP_PLIST] },
    { argv: [CHMOD, "0644", PLANE_BACKUP_PLIST] },
    { argv: ["/usr/bin/plutil", "-lint", PLANE_BACKUP_PLIST] },
  ]
  const repo = shellQuote(config.repository)
  const notes = [
    "Not done by this script. Do these as the owner, in order:",
    "1. The passphrase. The daemon is root and cannot read your login Keychain, so it reads a root-only file. Copy the Keychain item into it (the file already exists as 0600 root):",
    `   security find-generic-password -s ${KEYCHAIN.service} -a ${KEYCHAIN.account} -w | sudo tee ${shellQuote(passwordFile)} >/dev/null`,
    `2. The repository must exist: restic init on ${repo} once, with that passphrase (infra/README.md, Backup).`,
    `3. Load the daemon. It runs every day at ${pad(PLANE_BACKUP_SCHEDULE.hour)}:${pad(PLANE_BACKUP_SCHEDULE.minute)}, not at load; run it once now to see it work:`,
    `   sudo launchctl bootstrap system ${PLANE_BACKUP_PLIST}`,
    `   sudo launchctl kickstart system/${PLANE_BACKUP_LABEL}`,
    `   tail ${shellQuote(BACKUP_LOG)}`,
    "4. Retire your own nightly job, which cannot read the plane's databases:",
    "   launchctl bootout gui/$(id -u)/com.eido.backup; rm -f ~/Library/LaunchAgents/com.eido.backup.plist",
    "To pick up a changed plan, re-run this script, then: sudo launchctl bootout system/" +
      `${PLANE_BACKUP_LABEL}; sudo launchctl bootstrap system ${PLANE_BACKUP_PLIST}`,
  ]
  return { config, plist, steps, notes }
}

/** The plan as a /bin/sh script: `set -eu`, one line per command, the owner steps as comments. */
export function renderPlaneBackup(plan: PlaneBackup): string {
  return [
    "#!/bin/sh",
    "# Generated by `node infra/backup/bin.ts plane`; review it, then run it with sudo (infra/backup-restore.md).",
    "set -eu",
    ...plan.steps.map(renderStep),
    ...plan.notes.map((note) => `# ${note}`),
    "",
  ].join("\n")
}
