// Entry point: hands process.argv, the tailscale CLI on PATH and the global fetch to main().
import { execFile } from "node:child_process"

import { main, type RunResult } from "./cli.ts"

const tailscale = (args: readonly string[]) =>
  new Promise<RunResult>((resolve) => {
    execFile("tailscale", [...args], (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof error.code === "number" ? error.code : 1
      resolve({ code, stdout, stderr: stderr || (error?.message ?? "") })
    })
  })

process.exitCode = await main(process.argv.slice(2), {
  tailscale,
  fetch: (url) => fetch(url),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
