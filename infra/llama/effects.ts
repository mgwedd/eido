// The real effects for the llama CLI and the stack supervisor: files, processes, launchctl,
// signals and fetch. No logic: the CLI and the supervisor are tested with fakes.
import { execFile, spawn } from "node:child_process"
import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

import type { Deps, ServerProcess } from "./cli.ts"
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

// Follows the lock URL's redirects (GitHub and Hugging Face hand off to their CDNs), but only over
// https, and writes a new file only: an existing one is never overwritten.
const download = async (url: string, dest: string): Promise<void> => {
  const response = await fetch(url, { redirect: "follow" })
  if (!response.url.startsWith("https://"))
    throw new Error(`redirected off https to ${response.url}`)
  if (!response.ok || response.body === null)
    throw new Error(`HTTP ${response.status}`)
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(dest, { flags: "wx", mode: 0o644 })
  )
}

export function llamaEffects(): Deps {
  return {
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
    download,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onStopSignal: (handler) => {
      process.once("SIGTERM", handler)
      process.once("SIGINT", handler)
    },
    fs: {
      exists: existsSync,
      mkdir: (path) => void mkdirSync(path, { recursive: true }),
      writeFile: (path, text) => writeFileSync(path, text, { mode: 0o644 }),
      rename: (from, to) => renameSync(from, to),
      remove: (path) => rmSync(path),
      removeTree: (path) => rmSync(path, { recursive: true, force: true }),
      list: (dir) =>
        readdirSync(dir, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          directory: entry.isDirectory(),
        })),
    },
    settings: {
      read: (path) =>
        existsSync(path) ? readFileSync(path, "utf8") : undefined,
      stat: (path) => {
        try {
          const stat = lstatSync(path)
          return { isFile: stat.isFile(), mode: stat.mode, size: stat.size }
        } catch {
          return undefined
        }
      },
      write: (path, text) => {
        writeFileSync(path, text, { mode: 0o600 })
        chmodSync(path, 0o600)
      },
      ensurePrivateDir: (path) => {
        mkdirSync(path, { recursive: true, mode: 0o700 })
        chmodSync(path, 0o700)
      },
    },
    env: process.env,
    home: homedir(),
    platform: { os: process.platform, arch: process.arch },
    uid: process.getuid?.(),
    node: process.execPath,
    launcher: fileURLToPath(new URL("./bin.ts", import.meta.url)),
    defaultLockPath: fileURLToPath(new URL("../model.lock", import.meta.url)),
    fixtureDir: fileURLToPath(new URL("./fixtures", import.meta.url)),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }
}
