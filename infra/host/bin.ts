// Entry point: hands process.argv, the environment and the real commands (fdesetup, tailscale,
// dscl) and the reviewed connector manifests to main(). Every command it runs only reads the host.
// Run it with `--import ./infra/ts-hooks.ts` (from the repo root), which @eido/schemas needs.
import { execFile } from "node:child_process"
import { lstatSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { REVIEWED_MANIFESTS } from "@eido/schemas"

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
  env: process.env,
  files: {
    read: (path) => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return undefined
      }
    },
    stat: (path) => {
      try {
        const stat = lstatSync(path)
        return { isFile: stat.isFile(), mode: stat.mode, size: stat.size }
      } catch {
        return undefined
      }
    },
  },
  repoRoot: fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, ""),
  execPath: process.execPath,
  manifests: REVIEWED_MANIFESTS,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
