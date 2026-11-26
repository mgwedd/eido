// The probe broker of the live isolation check (#820): the production broker
// (`packages/core/src/parsers/broker.ts`, #817) on a probe socket, with the parse child's entry
// swapped for `isolation-parser-child.ts`. The check starts it as `_eidoparse` under the installed
// `parser.sb` (see `isolation-parser-plan.ts`), loaded with the core hooks and the no-network
// preload as the LaunchDaemon loads them. The production broker's entry cannot take a different
// child entry, and the production daemon must never run an attack, so the check runs this one.
//
//   node ... isolation-parser-broker.ts --socket <path> --worker <path>
//
// It prints `{"ready":true}` once it listens, and stops when stdin ends or on a signal. Its scratch
// dir is a fresh private dir under the temp dir, removed on exit.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { startBroker } from "../packages/core/src/parsers/broker.ts"
import type { Broker } from "../packages/core/src/parsers/broker.ts"

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

async function main(argv: readonly string[]): Promise<number> {
  const socketPath = flagValue(argv, "--socket")
  const workerEntry = flagValue(argv, "--worker")
  if (
    socketPath === undefined ||
    workerEntry === undefined ||
    !isAbsolute(socketPath) ||
    !isAbsolute(workerEntry)
  ) {
    console.error("usage: --socket <absolute path> --worker <absolute path>")
    return 2
  }
  const scratchDir = mkdtempSync(join(tmpdir(), "eido-isolation-parser-"))
  let broker: Broker | undefined
  const stop = async (code: number) => {
    try {
      await broker?.close()
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
      process.exit(code)
    }
  }
  try {
    broker = await startBroker({ socketPath, scratchDir, workerEntry })
  } catch {
    rmSync(scratchDir, { recursive: true, force: true })
    process.stdout.write(`${JSON.stringify({ ready: false })}\n`)
    return 1
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => void stop(0))
  process.stdin.on("end", () => void stop(0))
  process.stdin.resume()
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`)
  return 0
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  if (code !== 0) process.exit(code)
}
