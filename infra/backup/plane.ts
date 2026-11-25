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
} from "../host/plane.ts"
import {
  KEYCHAIN,
  PLANE_BACKUP_DIR,
  PLANE_BACKUP_LOG_DIR,
  planeBackupConfig,
  type BackupConfig,
} from "./config.ts"
import { BackupError } from "./errors.ts"

export const PLANE_BACKUP_LABEL = "com.eido.plane.backup"
export const PLANE_BACKUP_PLIST = `${DAEMON_DIR}/${PLANE_BACKUP_LABEL}.plist`
/** Runs at load and then once a day; `check` allows 36 hours, so a sleeping Mac has slack. */
export const PLANE_BACKUP_INTERVAL_SECONDS = 86_400
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
  /** The node binary the daemon runs. */
  node: string
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

export function planeBackup(input: PlaneBackupInput): PlaneBackup {
  if (!input.node.startsWith("/"))
    throw new BackupError(
      `the node binary must be an absolute path, not ${JSON.stringify(input.node)}`
    )
  const config = planeBackupConfig(input.repository)
  const passwordFile = config.passwordFile ?? ""
  const plist = daemonPlist({
    label: PLANE_BACKUP_LABEL,
    user: "root",
    group: "wheel",
    args: [input.node, "--disable-warning=ExperimentalWarning", BIN, "run"],
    cwd: "/",
    env: {
      // restic's cache lands under HOME, inside the root-only backup directory.
      HOME: PLANE_BACKUP_DIR,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      EIDO_BACKUP_PLANE: "split",
      EIDO_BACKUP_REPO: config.repository,
    },
    outLog: BACKUP_LOG,
    errLog: BACKUP_LOG,
    keepAlive: false,
    interval: PLANE_BACKUP_INTERVAL_SECONDS,
  })
  const steps: Step[] = [
    // The script stops here on a host where the plane was never applied.
    ...config.databases.map((db) => ({
      argv: ["/bin/test", "-d", posix.dirname(db.path)],
    })),
    { argv: ["/bin/test", "-f", BIN] },
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
    "3. Load the daemon. It runs at once, then every 24 hours:",
    `   sudo launchctl bootstrap system ${PLANE_BACKUP_PLIST}`,
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
