// Entry point: hands process.argv, the real restic binary, the clock and the console to main().
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

import { main } from "./cli.ts"
import type { ResticResult, ResticRun } from "./restic.ts"

// A split host's root daemon names restic by absolute path; PATH is only a single-user fallback.
const env = process.env
const RESTIC = env["EIDO_RESTIC_BIN"] ?? "restic"

const run: ResticRun = (args, resticEnv) =>
  new Promise<ResticResult>((resolve) => {
    execFile(
      RESTIC,
      [...args],
      { env: { ...env, ...resticEnv }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr })
        else if (typeof error.code === "number")
          resolve({ code: error.code, stdout, stderr })
        else
          resolve({
            code: 127,
            stdout,
            stderr: `restic did not run (is it installed and on PATH?): ${error.message}`,
          })
      }
    )
  })

const stamp = (line: string) => `${new Date().toISOString()} ${line}`

process.exitCode = await main(process.argv.slice(2), {
  run,
  now: () => new Date(),
  // launchd sends stdout and stderr to the same log file.
  log: (line) => console.log(stamp(line)),
  env,
  home: homedir(),
  repoRoot: join(import.meta.dirname, "..", ".."),
  nodePath: process.execPath,
  binPath: join(import.meta.dirname, "bin.ts"),
  io: { out: (line) => console.log(line), err: (line) => console.error(line) },
})
