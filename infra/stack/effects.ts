// The real effects for the stack CLI and the supervisor: child processes, signals, files, the
// clock and fetch. Each process runs in its own process group, so stop reaches the children it
// spawns too (node --watch's runner, core's scrubbed re-run, Next's server). No logic.
import { execFile, spawn } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline/promises"
import { setTimeout as sleep } from "node:timers/promises"

import { sha256File } from "../llama/verify.ts"

import type { Deps } from "./cli.ts"
import { platformOf } from "./config.ts"
import type { RunResult } from "./ports.ts"
import { processControl } from "./process-control.ts"
import { lineWriter } from "./supervise.ts"

const repoRoot = join(import.meta.dirname, "..", "..")

const resolveCommand = (command: string) => {
  if (process.platform === "win32" && command === "tailscale")
    return "tailscale.exe"
  return command
}

const exec = (command: string, args: readonly string[]) =>
  new Promise<RunResult>((resolve) => {
    execFile(resolveCommand(command), [...args], (error, stdout, stderr) => {
      if (error === null) resolve({ code: 0, stdout, stderr })
      // A numeric code is the program's exit status; anything else means it did not run.
      else if (typeof error.code === "number")
        resolve({ code: error.code, stdout, stderr })
      else resolve({ code: 127, stdout, stderr: error.message })
    })
  })

const launch: Deps["launch"] = (spec, options) => {
  mkdirSync(dirname(options.logFile), { recursive: true })
  appendFileSync(
    options.logFile,
    `=== ${spec.name} start ${new Date().toISOString()}\n`
  )
  const env = { ...process.env, ...spec.env }
  const detached = process.platform !== "win32"
  if (options.background) {
    const fd = openSync(options.logFile, "a")
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      detached,
      stdio: ["ignore", fd, fd],
    })
    closeSync(fd)
    child.unref()
    return {
      pid: child.pid ?? 0,
      exited: new Promise((resolve) => child.once("exit", resolve)),
    }
  }
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const toLog = (line: string) => appendFileSync(options.logFile, `${line}\n`)
  const toTerminal = lineWriter(`${spec.name.padEnd(4)} | `, (line) =>
    console.log(line)
  )
  for (const stream of [child.stdout, child.stderr]) {
    const log = lineWriter("", toLog)
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      log.push(chunk)
      if (options.prefixOutput) toTerminal.push(chunk)
    })
    stream.on("end", () => {
      log.flush()
      if (options.prefixOutput) toTerminal.flush()
    })
  }
  return {
    pid: child.pid ?? 0,
    exited: new Promise((resolve) => child.once("exit", resolve)),
  }
}

const groupAlive = (pid: number) => {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    // EPERM: the group exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function stackEffects(): Deps {
  const platform = platformOf(process.platform)
  const control = processControl(platform, exec)
  return {
    platform,
    control,
    env: process.env,
    home: homedir(),
    repoRoot,
    nodePath: process.execPath,
    uid: process.getuid?.(),
    exec,
    build: () =>
      new Promise((resolve) => {
        const child = spawn("pnpm", ["turbo", "run", "build"], {
          cwd: repoRoot,
          stdio: "inherit",
        })
        child.once("exit", (code) => resolve(code ?? 1))
        child.once("error", () => resolve(1))
      }),
    launch,
    fetch: (url) =>
      fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) }),
    clock: { now: () => Date.now(), sleep: (ms) => sleep(ms) },
    signalGroup: (pid, signal) => {
      try {
        process.kill(-pid, signal)
      } catch {
        // the group is already gone
      }
    },
    groupAlive,
    files: {
      exists: (path) => existsSync(path),
      read: (path) =>
        existsSync(path) ? readFileSync(path, "utf8") : undefined,
      write: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
      remove: (path) => rmSync(path, { force: true }),
      ensurePrivateDir: (path) => {
        mkdirSync(path, { recursive: true, mode: 0o700 })
        chmodSync(path, 0o700)
      },
      stat: (path) => {
        try {
          const stat = lstatSync(path)
          return { isFile: stat.isFile(), mode: stat.mode, size: stat.size }
        } catch {
          return undefined
        }
      },
      setMode: (path, mode) => chmodSync(path, mode),
    },
    nodeVersion: process.version,
    sha256: sha256File,
    // The terminal is inherited, so a password prompt goes straight from the user to the program.
    interactive: (command, args, options = {}) =>
      new Promise((resolve) => {
        const child = spawn(command, [...args], {
          cwd: options.cwd ?? repoRoot,
          env: { ...process.env, ...options.env },
          stdio: "inherit",
        })
        child.once("exit", (code) => resolve(code ?? 1))
        child.once("error", () => resolve(127))
      }),
    ask: async (question) => {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      try {
        return await prompt.question(question)
      } finally {
        prompt.close()
      }
    },
    onStopSignal: (handler) => {
      let called = false
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
        process.on(signal, () => {
          if (called) return
          called = true
          handler()
        })
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }
}
