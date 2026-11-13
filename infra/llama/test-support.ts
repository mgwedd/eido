// The fake machine the CLI and supervisor tests share.
import { readFileSync } from "node:fs"

import { type Deps, type ServerProcess } from "./cli.ts"
import type { Platform } from "./config.ts"
import type { HttpResponse } from "./server.ts"
import type { RunResult } from "./verify.ts"

// The committed lock with the Qwen and gpt-oss profiles marked unverified again: these tests use
// them as the examples of a profile that has not passed a template check on this machine, whatever
// model.lock says about the host's own run. lock.test.ts reads the lock itself.
export const LOCK = readFileSync(
  new URL("../model.lock", import.meta.url),
  "utf8"
).replace(
  /(\n\[profile (?:qwen3\.6-35b-a3b|gpt-oss-20b)\]\n(?:(?!\n\[).)*?\nverified: )true/gs,
  "$1false"
)
export const SHA =
  "3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d"
export const SIZE = 14439363584
export const QWEN_SHA =
  "ac0e2c1189e055faa36eff361580e79c5bd6f8e76bffb4ce547f167d53e31a61"
export const QWEN_SIZE = 22134528992
export const OSS_SHA =
  "27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901"
export const OSS_SIZE = 12109566624
export const ASSET_SHA =
  "791eb0200a7c846ca925b6274fc21f0f21f537fda2924cc5a47402655816f56e"
export const HOME = "/Users/u"
export const ROOT = `${HOME}/Library/Application Support/eido-dev`
export const MODEL = `${ROOT}/models/gemma-4-26B_q4_0-it.gguf`
export const QWEN = `${ROOT}/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`
export const OSS = `${ROOT}/models/gpt-oss-20b-MXFP4.gguf`
export const BIN = `${ROOT}/llama.cpp/b11149/llama-server`
export const SETTINGS = `${ROOT}/stack.env`
export const PROFILES = `${ROOT}/profiles.lock`
export const RECORD = `${ROOT}/verified-profiles`
export const PLIST = `${HOME}/Library/LaunchAgents/com.eido.llama-server.plist`
export const VERSION = "version: 0.5.0-dev (build 11149, commit d2e54583c)\n"
export const REFERENCE = "<|turn>user\nThanks.<turn|>\n<|turn>model\n"
export const QWEN_PASS = `qwen3.6-35b-a3b ${QWEN_SHA} b11149\n`
export const PRINT = "launchctl print gui/501/com.eido.llama-server"
export const OK: RunResult = { code: 0, stdout: "", stderr: "" }
export const WIN: Platform = { os: "win32", arch: "x64" }

export const reply = (status: number, body: unknown): HttpResponse => ({
  status,
  json: () => Promise.resolve(body),
})

export const fail = (): never => {
  throw new Error("llama-server was not spawned")
}

export const tick = () => new Promise((r) => setTimeout(r, 0))

export type Child = ServerProcess & {
  killed: string[]
  exit: (code: number) => void
}

export function child(): Child {
  let exit: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => (exit = resolve))
  const c: Child = {
    exited,
    killed: [],
    kill: (signal) => {
      c.killed.push(signal)
      exit(143)
    },
    exit: (code) => exit(code),
  }
  return c
}

export type Answer = HttpResponse | Error
export type Options = {
  sha?: string
  version?: RunResult
  files?: Record<string, string>
  /** Answers by URL path; a list is answered in turn, its last entry from then on. */
  http?: Record<string, Answer | Answer[]>
  runs?: Record<string, RunResult>
  env?: Record<string, string>
  platform?: Platform
  uid?: number
  /** The st_mode the settings store sees for an existing file. */
  settingsMode?: number
}

export const SIZES: Record<string, number> = {
  [MODEL]: SIZE,
  [QWEN]: QWEN_SIZE,
  [OSS]: OSS_SIZE,
}
export const SHAS: Record<string, string> = { [QWEN]: QWEN_SHA, [OSS]: OSS_SHA }

const norm = (p: string) => p.replace(/\\/g, "/")

export function harness(o: Options = {}) {
  const out: string[] = []
  const err: string[] = []
  const ran: string[] = []
  const spawned: {
    command: string
    args: readonly string[]
    process: Child
  }[] = []
  const written: Record<string, string> = {}
  const privately: string[] = []
  const removed: string[] = []
  const made: string[] = []
  const requests: string[] = []
  const downloaded: string[] = []
  let stop: () => void = () => {}
  const files: Record<string, string> = {
    "/repo/infra/model.lock": LOCK,
    [MODEL]: "",
    [BIN]: "",
    "/repo/infra/llama/fixtures/gemma-4-26B_q4_0-it.gguf.prompt.txt": REFERENCE,
    ...o.files,
  }
  const http: Record<string, Answer | Answer[]> = {
    "/health": reply(200, { status: "ok" }),
    "/props": reply(200, {
      chat_template: "'<|turn>model\n' + message['content']",
    }),
    "/apply-template": reply(200, { prompt: REFERENCE }),
    "/v1/chat/completions": reply(200, {
      choices: [
        {
          message: {
            content: '{"city":"a","country":"b","summary":"c","unit":"d"}',
          },
        },
      ],
    }),
    ...o.http,
  }
  let t = 0
  const deps: Deps = {
    readText: (path) => {
      const text = files[path] ?? files[norm(path)]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    probe: {
      size: (path) =>
        Promise.resolve(
          path in files || norm(path) in files
            ? (SIZES[path] ?? SIZES[norm(path)] ?? 10)
            : undefined
        ),
      sha256: (path) =>
        Promise.resolve(
          path === MODEL || norm(path) === MODEL
            ? (o.sha ?? SHA)
            : (SHAS[path] ?? SHAS[norm(path)] ?? ASSET_SHA)
        ),
      now: () => (t += 1000),
    },
    run: (command, args) => {
      const line = [command, ...args].join(" ")
      ran.push(line)
      if (line === `${BIN} --version`)
        return Promise.resolve(
          o.version ?? { code: 0, stdout: "", stderr: VERSION }
        )
      return Promise.resolve(
        o.runs?.[line] ?? { code: 1, stdout: "", stderr: "" }
      )
    },
    spawn: (command, args) => {
      const process = child()
      spawned.push({ command, args, process })
      return process
    },
    fetch: (url, init) => {
      const path = new URL(url).pathname
      requests.push(init === undefined ? url : `${url} ${init.body}`)
      const entry = http[path]
      const answer = Array.isArray(entry)
        ? entry.length > 1
          ? entry.shift()
          : entry[0]
        : entry
      if (answer === undefined || answer instanceof Error)
        return Promise.reject(answer ?? new Error("ECONNREFUSED"))
      return Promise.resolve(answer)
    },
    download: (url, dest) => {
      downloaded.push(`${url} -> ${dest}`)
      files[dest] = ""
      return Promise.resolve()
    },
    sleep: () => Promise.resolve(),
    onStopSignal: (handler) => (stop = handler),
    fs: {
      exists: (path) => path in files || norm(path) in files,
      mkdir: (path) => void made.push(path),
      writeFile: (path, text) => {
        written[path] = text
        files[path] = text
      },
      rename: (from, to) => {
        files[to] = files[from] ?? files[norm(from)] ?? ""
        delete files[from]
        delete files[norm(from)]
      },
      remove: (path) => {
        removed.push(path)
        delete files[path]
        delete files[norm(path)]
      },
      removeTree: (path) => void removed.push(`${path}/`),
      list: () => [],
    },
    settings: {
      read: (path) => files[path],
      stat: (path) =>
        path in files
          ? { isFile: true, mode: o.settingsMode ?? 0o100600, size: 1 }
          : undefined,
      write: (path, text) => {
        privately.push(path)
        written[path] = text
        files[path] = text
      },
      ensurePrivateDir: (path) => void made.push(path),
    },
    env: o.env ?? {},
    home: HOME,
    platform: o.platform ?? { os: "darwin", arch: "arm64" },
    uid: o.uid ?? 501,
    node: "/opt/node",
    launcher: "/repo/infra/llama/bin.ts",
    defaultLockPath: "/repo/infra/model.lock",
    fixtureDir: "/repo/infra/llama/fixtures",
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  }
  return {
    deps,
    files,
    out,
    err,
    ran,
    spawned,
    written,
    privately,
    removed,
    made,
    requests,
    downloaded,
    stop: () => stop(),
  }
}
