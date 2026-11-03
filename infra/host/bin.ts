// Entry point: hands process.argv and the real fdesetup and tailscale commands to main().
import { execFile } from "node:child_process"

import { main, type RunResult } from "./cli.ts"

const run = (command: string, args: readonly string[]) =>
  new Promise<RunResult>((resolve) => {
    execFile(command, [...args], (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof error.code === "number" ? error.code : 1
      resolve({ code, stdout, stderr: stderr || (error?.message ?? "") })
    })
  })

process.exitCode = await main(process.argv.slice(2), {
  run,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
