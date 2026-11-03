// launchctl argument building and `launchctl print` parsing for the Bridge LaunchAgent. Nothing
// here runs launchctl: the caller passes the arguments to an injected command runner.
import { LABEL } from "./plist.ts"

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
  lastExitStatus: string | undefined
}

function field(output: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*${name} = (.+)$`, "m").exec(output)
  return match?.[1]?.trim()
}

/** Reads state, pid, runs and last exit from `launchctl print gui/<uid>/<label>` output. */
export function parsePrint(output: string): JobStatus {
  const pid = field(output, "pid")
  const runs = field(output, "runs")
  return {
    state: field(output, "state"),
    pid: pid === undefined ? undefined : Number(pid),
    runs: runs === undefined ? undefined : Number(runs),
    lastExitStatus: field(output, "last exit code"),
  }
}
