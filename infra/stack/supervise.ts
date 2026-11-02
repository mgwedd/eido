// Starting the processes in order, waiting for each to answer, and stopping them again. Effects
// (spawning, signals, HTTP, the clock) are passed in, so the order and the stop rules are tested
// without a real process.
import type { Mode, ProcessName, ProcessSpec } from "./config.ts"

export type Launched = {
  pid: number
  /** Resolves with the exit code (null when killed by a signal) once the process exits. */
  exited: Promise<number | null>
}

/** The HTTP status `url` answers with, or undefined when nothing answers. */
export type Probe = (url: string) => Promise<number | undefined>

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> }

export const POLL_MS = 250

export const answers = (status: number | undefined): boolean =>
  status !== undefined && status < 500

/**
 * Waits until `spec` answers its health check (and `alsoReady`, when given, holds). Fails when
 * the process exits first or the spec's timeout passes.
 */
export async function waitReady(
  spec: ProcessSpec,
  launched: Launched,
  deps: { probe: Probe; clock: Clock; alsoReady?: () => boolean }
): Promise<string | undefined> {
  let exit: { code: number | null } | undefined
  void launched.exited.then((code) => {
    exit = { code }
  })
  const deadline = deps.clock.now() + spec.readyTimeoutMs
  for (;;) {
    // Let a pending exit settle before probing, so a crash is reported as a crash.
    await Promise.resolve()
    if (exit !== undefined)
      return `${spec.name} exited with code ${String(exit.code)} before it answered`
    if (
      (deps.alsoReady?.() ?? true) &&
      answers(await deps.probe(spec.healthUrl))
    )
      return undefined
    if (deps.clock.now() >= deadline)
      return `${spec.name} did not answer ${spec.healthUrl} within ${spec.readyTimeoutMs / 1000} s`
    await deps.clock.sleep(POLL_MS)
  }
}

export type Started = { spec: ProcessSpec; launched: Launched }

/**
 * Launches the processes one at a time, in the order given, and starts the next only once the
 * one before it answers. On a failure it stops there: the caller stops what did start.
 */
export async function startInOrder(
  specs: readonly ProcessSpec[],
  deps: {
    launch: (spec: ProcessSpec) => Launched
    ready: (
      spec: ProcessSpec,
      launched: Launched
    ) => Promise<string | undefined>
  }
): Promise<{ started: Started[]; failure?: string }> {
  const started: Started[] = []
  for (const spec of specs) {
    const launched = deps.launch(spec)
    started.push({ spec, launched })
    const failure = await deps.ready(spec, launched)
    if (failure !== undefined) return { started, failure }
  }
  return { started }
}

/** What a pid file holds: the process group leader and how to recognise it again. */
export type PidRecord = {
  name: ProcessName
  pid: number
  marker: string
  mode: Mode
}

const NAMES: readonly string[] = ["gate", "core", "web"]

export function parsePidRecord(text: string): PidRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const { name, pid, marker, mode } = value as Record<string, unknown>
  if (
    typeof name !== "string" ||
    !NAMES.includes(name) ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    typeof marker !== "string" ||
    marker === "" ||
    (mode !== "dev" && mode !== "prod")
  )
    return undefined
  return { name: name as ProcessName, pid, marker, mode }
}

export type Signal = "SIGTERM" | "SIGKILL"

export type StopDeps = {
  /** The pid's command line, or undefined when no such process runs. */
  argsOf: (pid: number) => Promise<string | undefined>
  /** Signals the process group led by `pid`. */
  signalGroup: (pid: number, signal: Signal) => void
  /** Whether any process is left in the group led by `pid`. */
  groupAlive: (pid: number) => boolean
  clock: Clock
}

export const STOP_GRACE_MS = 10_000

export type StopOutcome = "stopped" | "killed" | "not running" | "not ours"

async function waitGone(
  pid: number,
  deps: StopDeps,
  ms: number
): Promise<boolean> {
  const deadline = deps.clock.now() + ms
  while (deps.groupAlive(pid)) {
    if (deps.clock.now() >= deadline) return false
    await deps.clock.sleep(POLL_MS)
  }
  return true
}

/**
 * Stops the process group a pid file names: SIGTERM, then SIGKILL after the grace period. A pid
 * whose command line no longer carries the marker belongs to something else now and is left
 * alone. A group whose leader is gone but whose children remain is still stopped.
 */
export async function stopRecord(
  record: PidRecord,
  deps: StopDeps
): Promise<StopOutcome> {
  const args = await deps.argsOf(record.pid)
  if (args === undefined) {
    if (!deps.groupAlive(record.pid)) return "not running"
  } else if (!args.includes(record.marker)) {
    return "not ours"
  }
  deps.signalGroup(record.pid, "SIGTERM")
  if (await waitGone(record.pid, deps, STOP_GRACE_MS)) return "stopped"
  deps.signalGroup(record.pid, "SIGKILL")
  await waitGone(record.pid, deps, 2_000)
  return "killed"
}

/** Splits a stream into lines and writes each with `prefix`; `flush` writes a trailing partial line. */
export function lineWriter(prefix: string, write: (line: string) => void) {
  let pending = ""
  return {
    push(chunk: string): void {
      const parts = (pending + chunk).split("\n")
      pending = parts.pop() ?? ""
      for (const part of parts) write(`${prefix}${part}`)
    },
    flush(): void {
      if (pending !== "") write(`${prefix}${pending}`)
      pending = ""
    },
  }
}
