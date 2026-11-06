// The login agent `com.eido.stack` (#629): a LaunchAgent that runs the stack supervisor at login
// with `--start-stack`, so the supervisor starts the prod stack in the background and then serves
// its socket. KeepAlive restarts the supervisor when it exits, after the throttle; the stack's
// processes run in their own process groups, so they outlive a supervisor restart. Pure
// functions: tested without launchd.
import { escapeXml, parsePrint, type JobStatus } from "../llama/launchd.ts"

export const AGENT_LABEL = "com.eido.stack"

/** Seconds launchd waits before a restart, so a failing start does not spin. */
export const AGENT_THROTTLE_SECONDS = 10

export type AgentLayout = {
  plistPath: string
  logDir: string
  outLog: string
  errLog: string
}

/** launchd needs absolute paths: `~` is not expanded. */
export function agentLayout(home: string): AgentLayout {
  const logDir = `${home}/Library/Logs/eido-dev`
  return {
    plistPath: `${home}/Library/LaunchAgents/${AGENT_LABEL}.plist`,
    logDir,
    outLog: `${logDir}/stack.out.log`,
    errLog: `${logDir}/stack.err.log`,
  }
}

/**
 * The variables the agent passes on from the installing shell. launchd starts jobs with a bare
 * PATH, and the stack needs pnpm, tailscale, lsof and ps on it. EIDO_STACK_DIR says where
 * stack.env is when it is not the default; every other setting comes from stack.env.
 */
export const AGENT_ENV_KEYS = ["PATH", "EIDO_STACK_DIR"] as const

export function agentEnv(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of AGENT_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined && value !== "") picked[key] = value
  }
  return picked
}

export type AgentPlistInput = {
  home: string
  /** Absolute path of the node binary. */
  node: string
  repoRoot: string
  env: Record<string, string>
}

const str = (value: string) => `<string>${escapeXml(value)}</string>`

export function agentProgramArguments(input: AgentPlistInput): string[] {
  return [
    input.node,
    "--disable-warning=ExperimentalWarning",
    "--import",
    `${input.repoRoot}/infra/ts-hooks.ts`,
    `${input.repoRoot}/infra/stack/supervisor-main.ts`,
    "--start-stack",
  ]
}

export function buildAgentPlist(input: AgentPlistInput): string {
  const paths = agentLayout(input.home)
  const args = agentProgramArguments(input)
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
  ${str(AGENT_LABEL)}
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  ${str(`${input.repoRoot}/infra`)}
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${AGENT_THROTTLE_SECONDS}</integer>
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

export const agentTarget = (uid: number): string => `gui/${uid}/${AGENT_LABEL}`
export const agentBootstrapArgs = (
  uid: number,
  plistPath: string
): string[] => ["bootstrap", `gui/${uid}`, plistPath]
export const agentBootoutArgs = (uid: number): string[] => [
  "bootout",
  agentTarget(uid),
]
export const agentPrintArgs = (uid: number): string[] => [
  "print",
  agentTarget(uid),
]

/** What `launchctl print` and the plist file say about the agent. */
export type AgentState =
  | { kind: "unsupported" }
  | { kind: "not installed" }
  | { kind: "not loaded" }
  | { kind: "loaded"; job: JobStatus; plist: boolean }

export function agentState(
  printed: { code: number; stdout: string } | undefined,
  plistExists: boolean
): AgentState {
  if (printed === undefined) return { kind: "unsupported" }
  if (printed.code === 0)
    return {
      kind: "loaded",
      job: parsePrint(printed.stdout),
      plist: plistExists,
    }
  return plistExists ? { kind: "not loaded" } : { kind: "not installed" }
}

/** The `stack:status` line for the agent. */
export function agentStatusLine(state: AgentState): string {
  switch (state.kind) {
    case "unsupported":
      return "login agent: launchd only; not on this platform yet (#455)"
    case "not installed":
      return "login agent: not installed (pnpm stack:install starts the stack at login)"
    case "not loaded":
      return "login agent: installed but not loaded; pnpm stack:install loads it"
    case "loaded": {
      const { job } = state
      const parts = [
        job.state ?? "state unknown",
        ...(job.pid === undefined ? [] : [`pid ${job.pid}`]),
        ...(job.runs === undefined ? [] : [`runs ${job.runs}`]),
        ...(job.lastExit === undefined ? [] : [`last exit ${job.lastExit}`]),
      ]
      const missing = state.plist
        ? ""
        : "; its plist is gone, so pnpm stack:uninstall it"
      return `login agent: loaded (${parts.join(", ")})${missing}`
    }
  }
}
