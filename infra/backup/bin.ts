// Entry point: hands process.argv, the real restic binary, the clock and the console to main().
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

import { main } from "./cli.ts"
import type { ResticResult, ResticRun } from "./restic.ts"

const run: ResticRun = (args, env) =>
  new Promise<ResticResult>((resolve) => {
    execFile(
      "restic",
      [...args],
      { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
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
  env: process.env,
  home: homedir(),
  repoRoot: join(import.meta.dirname, "..", ".."),
  nodePath: process.execPath,
  binPath: join(import.meta.dirname, "bin.ts"),
  io: { out: (line) => console.log(line), err: (line) => console.error(line) },
})
