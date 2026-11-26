// The parse child of the live isolation probe (#820). The probe broker starts it exactly as the
// production broker starts `worker.ts`: `node --import ts-hooks --import no-network <this> <job>`,
// inside the broker's sandbox. It runs in two modes:
//
// - worker (a job file as the argument): reads the probe document the broker stored, which names
//   one target, and starts a grandchild to try it. The no-network preload is in this process, so
//   the attempt itself runs in a grandchild started without it: it models native code or an OCR
//   engine, which the preload cannot stop, and so shows what the OS fence does. The grandchild's
//   report becomes the text of an ordinary parse result.
// - attempt (`--attempt <target json>`): tries the target as itself and prints one report line.
//
// It never reads a file's content: opening it is the whole attempt.
import { spawnSync } from "node:child_process"
import { closeSync, openSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import { fileURLToPath } from "node:url"
import { readJob, writeResult } from "../packages/core/src/parsers/child-io.ts"
import {
  readAttemptReport,
  readParserTarget,
  safeCode,
} from "./isolation-parser.ts"
import type { AttemptReport, ParserTarget } from "./isolation-parser.ts"

const SELF = fileURLToPath(import.meta.url)

function reachSocket(
  target: { host: string; port: number } | { path: string },
  timeoutMs: number
): Promise<{ reached: boolean; code: string }> {
  return new Promise((resolve) => {
    const socket = connect(target)
    const settle = (result: { reached: boolean; code: string }) => {
      socket.destroy()
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(
      () => settle({ reached: false, code: "ETIMEDOUT" }),
      timeoutMs
    )
    socket.once("connect", () => settle({ reached: true, code: "OK" }))
    socket.once("error", (error) =>
      settle({ reached: false, code: safeCode(error) })
    )
  })
}

/** Tries one target as this process. */
export async function attempt(target: ParserTarget): Promise<AttemptReport> {
  switch (target.kind) {
    case "tcp":
      return {
        kind: "tcp",
        ...(await reachSocket(
          { host: target.host, port: target.port },
          target.timeoutMs
        )),
      }
    case "unix":
      return {
        kind: "unix",
        ...(await reachSocket({ path: target.path }, target.timeoutMs)),
      }
    case "file":
      try {
        closeSync(openSync(target.path, "r"))
        return { kind: "file", reached: true, code: "OK" }
      } catch (error) {
        return { kind: "file", reached: false, code: safeCode(error) }
      }
  }
}

/** The grandchild's report line, or "" when it printed none. */
function runAttemptProcess(target: ParserTarget): string {
  const waitMs = target.kind === "file" ? 5000 : target.timeoutMs + 5000
  const run = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      SELF,
      "--attempt",
      JSON.stringify(target),
    ],
    {
      env: {},
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: waitMs,
    }
  )
  return run.stdout.trim().split("\n").at(-1) ?? ""
}

function payloadBlobPath(payload: unknown): string {
  const path =
    typeof payload === "object" && payload !== null && "blobPath" in payload
      ? payload.blobPath
      : undefined
  if (typeof path !== "string") throw new Error("the job has no document")
  return path
}

function runWorker(): void {
  const job = readJob()
  const target = readParserTarget(
    readFileSync(payloadBlobPath(job.payload), "utf8")
  )
  if (target === undefined) throw new Error("the document names no target")
  const sha256 =
    typeof job.payload === "object" &&
    job.payload !== null &&
    "sha256" in job.payload
      ? job.payload.sha256
      : undefined
  const text = runAttemptProcess(target)
  // What the grandchild printed is passed on only when it is a well-formed report, so a hostile
  // or broken grandchild can say nothing but "reached" or "refused with this errno name".
  const report = readAttemptReport(text)
  writeResult(job, {
    ok: true,
    sha256,
    trust: "untrusted",
    text: report === undefined ? "" : JSON.stringify(report),
    offsets: [],
    pages: null,
  })
}

async function runAttempt(argv: readonly string[]): Promise<void> {
  const target = readParserTarget(argv[1] ?? "")
  if (target === undefined) {
    process.exitCode = 2
    return
  }
  process.stdout.write(`${JSON.stringify(await attempt(target))}\n`)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  if (argv[0] === "--attempt") await runAttempt(argv)
  else runWorker()
}
