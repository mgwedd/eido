import { spawn } from "node:child_process"
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { FailureReason } from "./types"
import {
  createPrivateWorkDirectory,
  preparePrivateScratchRoot,
  recordPrivateWorkChild,
} from "./private-scratch"

// Runs one parse in a short-lived child process and reaps it. The portable fences are here: an
// empty environment (no tokens, no proxy variables, no credential paths), the no-network preload,
// a V8 heap cap and a wall-clock kill. OS-level rlimits and the network sandbox are #70.

const PARSERS = dirname(fileURLToPath(import.meta.url))
const TS_HOOKS = join(PARSERS, "..", "ts-hooks.ts")
const NO_NETWORK = join(PARSERS, "no-network.ts")

/** The child's whole environment. Nothing from the parent is inherited. */
export const CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({})

const STDERR_TAIL_BYTES = 64 * 1024
const HEAP_ABORT = /heap out of memory|Reached heap limit|Allocation failed/i

export type ChildLimits = {
  timeoutMs: number
  heapMiB: number
  /** Largest result file the parent will read. */
  resultBytes: number
}

export type ChildOutcome =
  | { ok: true; value: unknown }
  | { ok: false; reason: FailureReason; detail: string }

export type ChildRun = {
  /** The entry module the child runs; it reads its job with child-io.ts. */
  entry: string
  payload: unknown
  limits: ChildLimits
  /** The directory the child's temp work dir is made in. */
  tmpRoot: string
}

/** The Node arguments for a parse child: heap cap, no eval, the TypeScript and no-network preloads. */
export function childArgs(
  entry: string,
  jobPath: string,
  heapMiB: number
): string[] {
  return [
    `--max-old-space-size=${String(heapMiB)}`,
    "--disallow-code-generation-from-strings",
    "--disable-warning=ExperimentalWarning",
    "--import",
    TS_HOOKS,
    "--import",
    NO_NETWORK,
    entry,
    jobPath,
  ]
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    // The child leads its own process group, so an OCR engine it started dies with it.
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL")
  } catch {
    // already gone
  }
}

function readOutcome(resultPath: string, resultBytes: number): ChildOutcome {
  let size: number
  try {
    size = statSync(resultPath).size
  } catch {
    return {
      ok: false,
      reason: "crashed",
      detail: "the parser exited without a result",
    }
  }
  if (size > resultBytes) {
    return {
      ok: false,
      reason: "oversize",
      detail: "the parser's result is too large",
    }
  }
  try {
    const value: unknown = JSON.parse(readFileSync(resultPath, "utf8"))
    return { ok: true, value }
  } catch {
    return {
      ok: false,
      reason: "crashed",
      detail: "the parser's result is not JSON",
    }
  }
}

/** Runs `entry` in a child process. Never throws for anything the child does. */
export async function runInChild(run: ChildRun): Promise<ChildOutcome> {
  preparePrivateScratchRoot(run.tmpRoot)
  const workDir = createPrivateWorkDirectory(run.tmpRoot)
  try {
    const resultPath = join(workDir, "result.json")
    const jobPath = join(workDir, "job.json")
    writeFileSync(
      jobPath,
      JSON.stringify({ resultPath, workDir, payload: run.payload }),
      {
        flag: "wx",
        mode: 0o600,
      }
    )
    const child = spawn(
      process.execPath,
      childArgs(run.entry, jobPath, run.limits.heapMiB),
      {
        cwd: workDir,
        env: CHILD_ENV,
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      }
    )
    if (child.pid !== undefined) {
      try {
        recordPrivateWorkChild(workDir, child.pid)
      } catch (error) {
        killTree(child.pid)
        throw error
      }
    }
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, run.limits.timeoutMs)
    const exit = await new Promise<{
      code: number | null
      signal: string | null
    }>((resolve) => {
      child.once("error", () => resolve({ code: null, signal: null }))
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    clearTimeout(timer)
    // Whatever it started (an OCR engine) goes too.
    killTree(child.pid)
    if (timedOut) {
      return {
        ok: false,
        reason: "timeout",
        detail: `killed after ${String(run.limits.timeoutMs)} ms`,
      }
    }
    if (HEAP_ABORT.test(stderr)) {
      return {
        ok: false,
        reason: "memory",
        detail: `the parser passed its ${String(run.limits.heapMiB)} MiB heap cap`,
      }
    }
    if (exit.code !== 0) {
      return {
        ok: false,
        reason: "crashed",
        detail: `the parser exited with ${exit.signal ?? String(exit.code)}`,
      }
    }
    return readOutcome(resultPath, run.limits.resultBytes)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
