// The LaunchAgent that supervises Proton Bridge (#68). Pure functions: the plist text and the
// paths it names are built from plain inputs, so they are tested without launchd. The plist holds
// no credential and no port: the Bridge password lives in the vault, and Bridge picks its own
// ports, which are read from Bridge after login and set in the gate's EIDO_BRIDGE_* variables.

export const LABEL = "com.eido.proton-bridge"

/** Where Proton's official release puts the launcher. Overridable with --bridge. */
export const DEFAULT_BRIDGE_PATH =
  "/Applications/Proton Mail Bridge.app/Contents/MacOS/bridge"

/** Seconds launchd waits before restarting a Bridge that exited, so a crash loop does not spin. */
export const THROTTLE_SECONDS = 10

export type Layout = {
  plistPath: string
  logDir: string
  outLog: string
  errLog: string
}

/** The plist and log locations for `home`. launchd needs absolute paths: `~` is not expanded. */
export function layout(home: string): Layout {
  const logDir = `${home}/Library/Logs/eido`
  return {
    plistPath: `${home}/Library/LaunchAgents/${LABEL}.plist`,
    logDir,
    outLog: `${logDir}/proton-bridge.out.log`,
    errLog: `${logDir}/proton-bridge.err.log`,
  }
}

/** Bridge in CLI mode with no window and no interactive prompt, as launchd starts it. */
export function programArguments(bridgePath: string): string[] {
  return [bridgePath, "--cli", "--noninteractive"]
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

export type PlistInput = { bridgePath: string; home: string }

/**
 * The plist text. KeepAlive restarts Bridge after any exit; ThrottleInterval spaces restarts;
 * ProcessType Standard keeps the system from throttling it as a Background job.
 */
export function buildPlist(input: PlistInput): string {
  const paths = layout(input.home)
  const args = programArguments(input.bridgePath)
    .map((arg) => `    ${str(arg)}`)
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
