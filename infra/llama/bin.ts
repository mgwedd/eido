// Entry point: hands process.argv and real files, processes, launchctl, signals and fetch to main().
import { execFile, spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

import { main, type ServerProcess } from "./cli.ts"
import { sha256File, type RunResult } from "./verify.ts"

const run = (command: string, args: readonly string[]) =>
  new Promise<RunResult>((resolve) => {
    execFile(command, [...args], (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof error.code === "number" ? error.code : 1
      resolve({ code, stdout, stderr: stderr || (error?.message ?? "") })
    })
  })

const startServer = (
  command: string,
  args: readonly string[]
): ServerProcess => {
  // Not detached: the server shares the launcher's process group, so launchd and Ctrl-C stop both.
  const child = spawn(command, [...args], { stdio: "inherit" })
  const exited = new Promise<number>((resolve) => {
    child.on("error", () => resolve(1))
    child.on("exit", (code) => resolve(code ?? 1))
  })
  return { exited, kill: (signal) => void child.kill(signal) }
}

if (process.getuid === undefined) {
  console.error("llama: macOS only")
  process.exit(1)
}

process.exitCode = await main(process.argv.slice(2), {
  readText: (path) => readFileSync(path, "utf8"),
  probe: {
    size: (path) => {
      try {
        const stat = statSync(path)
        return Promise.resolve(stat.isFile() ? stat.size : undefined)
      } catch {
        return Promise.resolve(undefined)
      }
    },
    sha256: sha256File,
    now: () => performance.now(),
  },
  run,
  spawn: startServer,
  fetch: (url, init) =>
    fetch(
      url,
      init && { ...init, headers: { "content-type": "application/json" } }
    ),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onStopSignal: (handler) => {
    process.once("SIGTERM", handler)
    process.once("SIGINT", handler)
  },
  fs: {
    exists: existsSync,
    mkdir: (path) => void mkdirSync(path, { recursive: true }),
    writeFile: (path, text) => writeFileSync(path, text, { mode: 0o644 }),
    remove: (path) => rmSync(path),
  },
  env: process.env,
  home: homedir(),
  uid: process.getuid(),
  node: process.execPath,
  launcher: fileURLToPath(import.meta.url),
  defaultLockPath: fileURLToPath(new URL("../model.lock", import.meta.url)),
  fixtureDir: fileURLToPath(new URL("./fixtures", import.meta.url)),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
