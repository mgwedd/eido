// The parts of the plane that have no dependency on the stack config, the egress allowlist or
// `@eido/schemas`: the plane's directories, a LaunchDaemon plist, and the shell steps that write
// it. They live apart from `plane.ts` so that `infra/backup`, which plain node runs without a
// workspace loader, can use them. Anything imported here must stay resolvable by plain node.
import { escapeXml } from "../llama/launchd.ts"
import { shellQuote } from "./shell.ts"

export { shellQuote }

/** Where the plane lives: outside every home, so neither service user reads the owner's files. */
export const PLANE_ROOT = "/Library/Application Support/Eido"
export const PLANE_LOGS = "/Library/Logs/Eido"
export const DAEMON_DIR = "/Library/LaunchDaemons"

/** launchd's umask for the plane's daemons: sockets and files start private. */
export const SERVICE_UMASK = 0o077
const THROTTLE_SECONDS = 10

/** A fixed time of day, in the host's local time. */
export type DailyAt = { hour: number; minute: number }

export type DaemonSpec = {
  label: string
  user: string
  group: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  outLog: string
  errLog: string
  /** A service restarts when it exits; the pf job runs at load and every `interval` seconds. */
  keepAlive: boolean
  interval?: number
  /** Run every day at this time instead of every `interval` seconds (ignored when `keepAlive`). */
  dailyAt?: DailyAt
  /** Run once when the daemon loads. Defaults to true; a calendar job turns it off. */
  runAtLoad?: boolean
}

const str = (value: string) => `<string>${escapeXml(value)}</string>`

function lifecycleKeys(spec: DaemonSpec): string[] {
  if (spec.keepAlive)
    return [
      "  <key>KeepAlive</key>",
      "  <true/>",
      "  <key>ThrottleInterval</key>",
      `  <integer>${String(THROTTLE_SECONDS)}</integer>`,
    ]
  if (spec.dailyAt !== undefined)
    return [
      "  <key>StartCalendarInterval</key>",
      "  <dict>",
      "    <key>Hour</key>",
      `    <integer>${String(spec.dailyAt.hour)}</integer>`,
      "    <key>Minute</key>",
      `    <integer>${String(spec.dailyAt.minute)}</integer>`,
      "  </dict>",
    ]
  if (spec.interval !== undefined)
    return [
      "  <key>StartInterval</key>",
      `  <integer>${String(spec.interval)}</integer>`,
    ]
  return []
}

export function daemonPlist(spec: DaemonSpec): string {
  const args = spec.args.map((arg) => `    ${str(arg)}`).join("\n")
  const env = Object.entries(spec.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) => `    <key>${escapeXml(key)}</key>\n    ${str(value)}`
    )
    .join("\n")
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${str(spec.label)}`,
    "  <key>UserName</key>",
    `  ${str(spec.user)}`,
    "  <key>GroupName</key>",
    `  ${str(spec.group)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  ${str(spec.cwd)}`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    env,
    "  </dict>",
    "  <key>Umask</key>",
    `  <integer>${String(SERVICE_UMASK)}</integer>`,
    "  <key>RunAtLoad</key>",
    spec.runAtLoad === false ? "  <false/>" : "  <true/>",
    ...lifecycleKeys(spec),
    "  <key>StandardOutPath</key>",
    `  ${str(spec.outLog)}`,
    "  <key>StandardErrorPath</key>",
    `  ${str(spec.errLog)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

export type Step = {
  argv: readonly string[]
  /** Fed to the command's standard input (a file's contents for `tee`). */
  stdin?: string
  /** A failure is expected when there is nothing to undo, as with `launchctl bootout`. */
  mayFail?: boolean
}

const EOF = "EIDO_EOF"

/** The steps as a /bin/sh script: what `plan` prints and what `apply` runs, one line each. */
export function renderStep(step: Step): string {
  const command = step.argv.map(shellQuote).join(" ")
  if (step.stdin !== undefined) {
    if (step.stdin.split("\n").includes(EOF))
      throw new Error(`a file to write contains the line ${EOF}`)
    return `${command} >/dev/null <<'${EOF}'\n${step.stdin}${EOF}`
  }
  return step.mayFail === true ? `${command} || true` : command
}
