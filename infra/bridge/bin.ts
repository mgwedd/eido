// Entry point: hands process.argv, the real launchctl, the filesystem and TCP to main().
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"

import { main, type RunResult } from "./cli.ts"
import { readGreetingOverTcp } from "./health.ts"

const launchctl = (args: readonly string[]) =>
  new Promise<RunResult>((resolve) => {
    execFile("launchctl", [...args], (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof error.code === "number" ? error.code : 1
      resolve({ code, stdout, stderr: stderr || (error?.message ?? "") })
    })
  })

if (process.getuid === undefined) {
  console.error("bridge: launchd is macOS only")
  process.exit(1)
}

process.exitCode = await main(process.argv.slice(2), {
  launchctl,
  readGreeting: readGreetingOverTcp,
  fs: {
    exists: existsSync,
    mkdir: (path) => void mkdirSync(path, { recursive: true }),
    writeFile: (path, text) => writeFileSync(path, text, { mode: 0o644 }),
    remove: (path) => rmSync(path),
  },
  env: process.env,
  home: homedir(),
  uid: process.getuid(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
