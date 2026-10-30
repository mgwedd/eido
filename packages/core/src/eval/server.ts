import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { loopbackBaseUrl } from "../inference/client"

// Starts and stops a candidate's llama-server, so a selection run loads one model at a time
// (several large models do not fit in memory together). The command is the owner's own,
// from their local candidates file; it is spawned without a shell.

export const DEFAULT_READY_TIMEOUT_SECONDS = 600
const STOP_GRACE_MS = 30_000

export interface RunningServer {
  stop(): Promise<void>
}

export interface StartServerOptions {
  baseUrl: string
  command: readonly string[]
  readyTimeoutSeconds?: number
  /** The server's stdout and stderr are appended here. */
  logFile: string
  /** Delay between readiness checks. Default 500 ms. */
  pollMs?: number
}

async function answers(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
    await response.body?.cancel()
    return response.status
  } catch {
    return undefined
  }
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve()
  return new Promise((resolve) => child.once("exit", () => resolve()))
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = exited(child)
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS)
  await done
  clearTimeout(timer)
}

/**
 * Spawns `command` and resolves once `GET /health` at `baseUrl` answers 200. Refuses to start
 * when something already answers there, so a stale server cannot be scored as this candidate.
 */
export async function startServer(
  options: StartServerOptions
): Promise<RunningServer> {
  const health = `${loopbackBaseUrl(options.baseUrl)}/health`
  if ((await answers(health)) !== undefined)
    throw new Error(
      `a server already answers at ${options.baseUrl}; stop it, or drop "server" from this candidate to use it as is`
    )
  const [program, ...args] = options.command
  if (program === undefined) throw new Error("server command is empty")
  const log = openSync(options.logFile, "a")
  let child: ChildProcess
  try {
    child = spawn(program, args, { stdio: ["ignore", log, log] })
  } finally {
    closeSync(log)
  }
  let spawnError: Error | undefined
  child.once("error", (error) => {
    spawnError = error
  })
  const deadline =
    Date.now() +
    (options.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS) * 1000
  const pollMs = options.pollMs ?? 500
  for (;;) {
    if (spawnError !== undefined)
      throw new Error(`could not start ${program}: ${spawnError.message}`)
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `${program} exited (${String(child.exitCode ?? child.signalCode)}) before it was ready; see ${options.logFile}`
      )
    if ((await answers(health)) === 200) return { stop: () => stopChild(child) }
    if (Date.now() >= deadline) {
      await stopChild(child)
      throw new Error(
        `${program} was not ready at ${health} in time; see ${options.logFile}`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
