// The LaunchAgent that keeps llama-server running (#29). launchd runs the launcher (`bin.ts
// launch`), which verifies the pin and then runs llama-server as its child; if either exits,
// launchd starts the launcher again, so every restart re-verifies the model. When the launcher
// dies, launchd also kills the rest of its process group (AbandonProcessGroup is false), so no
// orphaned llama-server holds the port. Pure functions: tested without launchd.

export const LABEL = "com.eido.llama-server"

/** Seconds launchd waits before a restart, so a failing pin does not spin. */
export const THROTTLE_SECONDS = 10

export type Layout = {
  plistPath: string
  logDir: string
  outLog: string
  errLog: string
}

/** launchd needs absolute paths: `~` is not expanded. */
export function layout(home: string): Layout {
  const logDir = `${home}/Library/Logs/eido`
  return {
    plistPath: `${home}/Library/LaunchAgents/${LABEL}.plist`,
    logDir,
    outLog: `${logDir}/llama-server.out.log`,
    errLog: `${logDir}/llama-server.err.log`,
  }
}

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

const str = (value: string) => `<string>${escapeXml(value)}</string>`

export type PlistInput = {
  home: string
  /** Absolute path of the node binary that runs the launcher. */
  node: string
  /** Absolute path of `infra/llama/bin.ts`. */
  launcher: string
  /** Non-secret settings the launcher reads: model dir, binary, port, lock path. */
  env: Record<string, string>
}

export function buildPlist(input: PlistInput): string {
  const paths = layout(input.home)
  const args = [
    input.node,
    "--disable-warning=ExperimentalWarning",
    input.launcher,
    "launch",
  ]
    .map((arg) => `    ${str(arg)}`)
    .join("\n")
  const env = Object.entries(input.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) => `    <key>${escapeXml(key)}</key>\n    ${str(value)}`
    )
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(LABEL)}
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${THROTTLE_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>StandardOutPath</key>
  ${str(paths.outLog)}
  <key>StandardErrorPath</key>
  ${str(paths.errLog)}
</dict>
</plist>
`
}

export const domain = (uid: number): string => `gui/${uid}`
export const target = (uid: number): string => `${domain(uid)}/${LABEL}`
export const bootstrapArgs = (uid: number, plistPath: string): string[] => [
  "bootstrap",
  domain(uid),
  plistPath,
]
export const bootoutArgs = (uid: number): string[] => ["bootout", target(uid)]
export const printArgs = (uid: number): string[] => ["print", target(uid)]

export type JobStatus = {
  state: string | undefined
  pid: number | undefined
  runs: number | undefined
  lastExit: string | undefined
}

function field(output: string, name: string): string | undefined {
  return new RegExp(`^\\s*${name} = (.+)$`, "m").exec(output)?.[1]?.trim()
}

/** Reads state, pid, runs and last exit code from `launchctl print gui/<uid>/<label>`. */
export function parsePrint(output: string): JobStatus {
  const pid = field(output, "pid")
  const runs = field(output, "runs")
  return {
    state: field(output, "state"),
    pid: pid === undefined ? undefined : Number(pid),
    runs: runs === undefined ? undefined : Number(runs),
    lastExit: field(output, "last exit code"),
  }
}
