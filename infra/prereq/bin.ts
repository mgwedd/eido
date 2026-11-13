// Entry point: hands process.argv and the real node, pnpm and corepack to main().
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"

import { main, type RunResult } from "./cli.ts"

const run = (command: string, args: readonly string[]) =>
  new Promise<RunResult>((resolve) => {
    // corepack and pnpm are .cmd shims on Windows, which only a shell resolves
    execFile(
      command,
      [...args],
      { shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1
        resolve({ code, stdout, stderr: stderr || (error?.message ?? "") })
      }
    )
  })

process.exitCode = await main(process.argv.slice(2), {
  run,
  nodeVersion: process.versions.node,
  readPackageJson: () =>
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
