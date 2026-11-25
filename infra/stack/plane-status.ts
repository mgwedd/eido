// The plane's two daemons as the stack reports them in split mode (#779): `com.eido.plane.gate`
// and `com.eido.plane.core` (infra/host/plane.ts), LaunchDaemons under their own users. The
// owner's stack does not start or stop them; `stack:status`, `stack:doctor` and the supervisor's
// jobs list only read them. `launchctl print system/<label>` needs no privilege for a loaded
// service; the run dir is not readable by the owner, so a socket is never probed, only the
// loopback health URLs the stack already uses.
import { DAEMON_DIR, LABELS } from "../host/plane.ts"
import { parsePrint } from "../llama/launchd.ts"
import type { Fetch } from "../tailscale/measure.ts"
import { healthUrl, type StackConfig } from "./config.ts"
import type { Exec } from "./ports.ts"

export const PLANE_PROCESSES = ["gate", "core"] as const
export type PlaneProcess = (typeof PLANE_PROCESSES)[number]

export const planeLabel = (name: PlaneProcess): string => LABELS[name]
export const planePlistPath = (name: PlaneProcess): string =>
  `${DAEMON_DIR}/${LABELS[name]}.plist`

export type PlaneDaemon =
  | { state: "running"; pid: number | undefined }
  /** Loaded, but launchd is not running it: crashed, throttled or stopped. */
  | { state: "stopped"; detail: string }
  /** The plist is in /Library/LaunchDaemons and launchd does not know the service. */
  | { state: "not-loaded" }
  /** No plist: the plane script has not been applied. */
  | { state: "missing" }

export type PlaneProbe = {
  exec: Exec
  exists: (path: string) => boolean
}

/** The daemon's state from `launchctl print system/<label>`; a plist on disk tells loaded from missing. */
export async function planeDaemon(
  name: PlaneProcess,
  probe: PlaneProbe
): Promise<PlaneDaemon> {
  const run = await probe.exec("launchctl", [
    "print",
    `system/${planeLabel(name)}`,
  ])
  if (run.code !== 0)
    return probe.exists(planePlistPath(name))
      ? { state: "not-loaded" }
      : { state: "missing" }
  const job = parsePrint(run.stdout)
  if (job.state === "running") return { state: "running", pid: job.pid }
  const parts = [
    `state ${job.state ?? "unknown"}`,
    ...(job.lastExit === undefined ? [] : [`last exit code ${job.lastExit}`]),
  ]
  return { state: "stopped", detail: parts.join(", ") }
}

/** One line for status and doctor: what the daemon is, and for a missing one how to get it. */
export function describePlaneDaemon(
  name: PlaneProcess,
  daemon: PlaneDaemon
): string {
  const label = planeLabel(name)
  switch (daemon.state) {
    case "running":
      return daemon.pid === undefined
        ? `${label} is running`
        : `${label} is running (pid ${daemon.pid})`
    case "stopped":
      return `${label} is loaded but not running (${daemon.detail}); see the log under /Library/Logs/Eido`
    case "not-loaded":
      return `${label} is installed but not loaded; run the plane script again (infra/plane-split.md)`
    case "missing":
      return `${label} is not installed; apply the plane script first (infra/plane-split.md)`
  }
}

/** The HTTP status of the daemon's loopback health URL, or undefined when it does not answer. */
export async function planeHealth(
  name: PlaneProcess,
  config: StackConfig,
  fetch: Fetch
): Promise<number | undefined> {
  try {
    return (await fetch(healthUrl(name, config.ports[name]))).status
  } catch {
    return undefined
  }
}
