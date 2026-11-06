// The port-in-use check: before start, each of the stack's ports must have no listener. lsof is
// asked rather than a trial bind, because a server on *:3000 (all interfaces, as plain `next dev`
// binds) does not stop a bind to 127.0.0.1:3000 on macOS, yet it answers on that address.
// Windows has no lsof; there `netstat -ano -p TCP` lists the listeners with their pids.
import type { Platform } from "./config.ts"

export type RunResult = { code: number; stdout: string; stderr: string }
export type Exec = (
  command: string,
  args: readonly string[]
) => Promise<RunResult>

export type Listener = { pid: number; command: string }

/** The lsof arguments that list the processes listening on TCP `port`, in field mode. */
export function lsofArgs(port: number): string[] {
  return ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]
}

/** Parses `lsof -Fpc` output: a `p<pid>` line, then a `c<command>` line, per process. */
export function parseLsof(stdout: string): Listener[] {
  const listeners: Listener[] = []
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1))
      if (Number.isSafeInteger(pid) && pid > 0)
        listeners.push({ pid, command: "" })
    } else if (line.startsWith("c")) {
      const last = listeners.at(-1)
      if (last !== undefined && last.command === "")
        last.command = line.slice(1)
    }
  }
  return listeners
}

/** The pids `netstat -ano -p TCP` shows LISTENING on `port`, on any local address. */
export function parseNetstat(stdout: string, port: number): Listener[] {
  const pids = new Set<number>()
  for (const line of stdout.split(/\r?\n/)) {
    const [proto, local, , state, pidText] = line.trim().split(/\s+/)
    if (proto !== "TCP" || state !== "LISTENING" || local === undefined)
      continue
    if (Number(local.slice(local.lastIndexOf(":") + 1)) !== port) continue
    const pid = Number(pidText)
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids].map((pid) => ({ pid, command: "" }))
}

/** The processes listening on `port`. lsof exits 1 with no output when there are none. */
export async function listenersOn(
  exec: Exec,
  port: number,
  platform: Platform
): Promise<Listener[]> {
  if (platform === "win32") {
    const run = await exec("netstat", ["-ano", "-p", "TCP"])
    if (run.code !== 0)
      throw new Error(
        `netstat failed: ${run.stderr.trim() || `exit ${run.code}`}`
      )
    return parseNetstat(run.stdout, port)
  }
  const run = await exec("lsof", lsofArgs(port))
  if (run.code !== 0 && run.stdout.trim() === "") {
    if (run.stderr.trim() === "") return []
    throw new Error(`lsof failed: ${run.stderr.trim()}`)
  }
  return parseLsof(run.stdout)
}

export function describeListeners(listeners: readonly Listener[]): string {
  return listeners
    .map((l) => `pid ${l.pid}${l.command === "" ? "" : ` (${l.command})`}`)
    .join(", ")
}

/** One message per port that has a listener, naming the port and the processes holding it. */
export async function busyPorts(
  exec: Exec,
  ports: readonly { name: string; port: number; variable: string }[],
  platform: Platform
): Promise<string[]> {
  const messages: string[] = []
  for (const { name, port, variable } of ports) {
    const listeners = await listenersOn(exec, port, platform)
    if (listeners.length > 0)
      messages.push(
        `port ${port} (${name}) is in use by ${describeListeners(listeners)}; stop it or set ${variable}`
      )
  }
  return messages
}
