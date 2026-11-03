// The nightly LaunchAgent, rendered from the same config the job reads, so the plist and the job
// cannot name different paths. It is printed, not installed: loading it is an owner step
// (infra/README.md). Only the variables below go into it; the repository passphrase is not one.
import type { BackupConfig } from "./config.ts"

export const LABEL = "com.eido.backup"
export const SCHEDULE = { hour: 3, minute: 15 } as const

/** Variables copied into the plist when set: they move data paths, and none is a secret. */
const PASSED_THROUGH = [
  "EIDO_STACK_DIR",
  "EIDO_DATA_DIR",
  "EIDO_GATE_DATA_DIR",
  "EIDO_BACKUP_LOG_DIR",
] as const

export type PlistInput = {
  config: BackupConfig
  env: Readonly<Record<string, string | undefined>>
  home: string
  nodePath: string
  /** Absolute path of infra/backup/bin.ts. */
  binPath: string
}

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const str = (text: string) => `<string>${escapeXml(text)}</string>`

export function renderPlist(input: PlistInput): string {
  const { config } = input
  const environment: [string, string][] = [
    ["HOME", input.home],
    // restic is installed by Homebrew or by hand; launchd's default PATH has neither.
    ["PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"],
    ["EIDO_BACKUP_REPO", config.repository],
  ]
  for (const name of PASSED_THROUGH) {
    const value = input.env[name]
    if (value !== undefined && value !== "") environment.push([name, value])
  }
  const log = `${config.logDir}/backup.log`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${str(input.nodePath)}
    ${str("--disable-warning=ExperimentalWarning")}
    ${str(input.binPath)}
    ${str("run")}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${SCHEDULE.hour}</integer>
    <key>Minute</key>
    <integer>${SCHEDULE.minute}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
${environment.map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    ${str(v)}`).join("\n")}
  </dict>
  <key>StandardOutPath</key>
  ${str(log)}
  <key>StandardErrorPath</key>
  ${str(log)}
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}
