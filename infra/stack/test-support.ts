// The fake machine the CLI and supervisor tests share.
import { readFileSync } from "node:fs"

import type { ServeConfig } from "../tailscale/serve-routes.ts"
import type { Deps, LaunchOptions } from "./cli.ts"
import type { ProcessSpec } from "./config.ts"
import type { RunResult } from "./ports.ts"
import type { FileStat } from "./settings.ts"

export const HOST = "node.example.ts.net"
export const STACK = "/home/u/Library/Application Support/eido-dev"
export const RUN = `${STACK}/run`
export const SETTINGS = `${STACK}/stack.env`
export const KEYCHAIN = "/home/u/Library/Keychains/eido/eido.keychain-db"
export const LLAMA_BIN = `${STACK}/llama.cpp/b11149/llama-server`
export const MODEL = `${STACK}/models/gemma-4-26B_q4_0-it.gguf`
export const SECRET = "client-secret-value-never-printed"
export const WEB_ENV = [
  "AUTH0_DOMAIN=tenant.example.invalid",
  "AUTH0_CLIENT_ID=abc",
  `AUTH0_CLIENT_SECRET=${SECRET}`,
  `AUTH0_SECRET=${SECRET}`,
  `APP_BASE_URL=http://localhost:3000,https://${HOST}:8443`,
  "EIDO_OWNER_EMAIL=owner@example.invalid",
].join("\n")
export const lockText = readFileSync(
  new URL("../model.lock", import.meta.url),
  "utf8"
)
export const gatePackageJson = readFileSync(
  new URL("../../packages/gate/package.json", import.meta.url),
  "utf8"
)

export const fixture = (name: string) =>
  readFileSync(
    new URL(`../tailscale/fixtures/${name}.json`, import.meta.url),
    "utf8"
  )
export const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" })

export type Proc = {
  spec: ProcessSpec
  options: LaunchOptions
  pid: number
  alive: boolean
  exit: (code: number | null) => void
}

/**
 * A stand-in for a ready Mac: doctor's checks pass (node, node_modules, .env.local, an unlocked
 * keychain, the pinned llama build and model, llama /health), launched processes listen on their
 * port and answer their health check, lsof and ps report them, signals end them, and tailscale
 * keeps a serve config. `env` replaces the default environment, which names the keychain.
 */
export function world(
  options: {
    env?: Deps["env"]
    settings?: { text: string; mode?: number }
    serve?: ServeConfig
    foreign?: Record<number, string>
    failToStart?: string
    buildCode?: number
    tailscaleDown?: boolean
    /** The login agent is loaded in launchd at the start. */
    agentLoaded?: boolean
    /** launchctl answers bootstrap or bootout with this failure. */
    launchctlFails?: "bootstrap" | "bootout"
    uid?: number
  } = {}
) {
  const procs: Proc[] = []
  const files = new Map<string, string>([
    ["/repo/package.json", JSON.stringify({ engines: { node: ">=24" } })],
    ["/repo/node_modules/.modules.yaml", ""],
    ["/repo/apps/web/.env.local", WEB_ENV],
    ["/repo/infra/model.lock", lockText],
    ["/repo/packages/gate/package.json", gatePackageJson],
  ])
  const stats = new Map<string, FileStat>([
    [KEYCHAIN, { isFile: true, mode: 0o100600, size: 1 }],
    [MODEL, { isFile: true, mode: 0o100644, size: 14439363584 }],
  ])
  if (options.settings !== undefined) {
    files.set(SETTINGS, options.settings.text)
    stats.set(SETTINGS, {
      isFile: true,
      mode: options.settings.mode ?? 0o100600,
      size: options.settings.text.length,
    })
  }
  const interactive: {
    command: string
    args: readonly string[]
    options: unknown
  }[] = []
  const dirs: string[] = []
  const out: string[] = []
  const err: string[] = []
  const tailscaleCalls: string[] = []
  const serve: ServeConfig = structuredClone(options.serve ?? {})
  let builds = 0
  let agentLoaded = options.agentLoaded === true
  const launchctlCalls: string[] = []
  const launchctl = (args: readonly string[]): RunResult => {
    launchctlCalls.push(args.join(" "))
    const [verb, target] = args
    if (verb === options.launchctlFails)
      return {
        code: 5,
        stdout: "",
        stderr: `${verb} failed: Input/output error`,
      }
    if (verb === "print")
      return agentLoaded && target === "gui/501/com.eido.stack"
        ? ok(
            "gui/501/com.eido.stack = {\n\tstate = running\n\truns = 2\n\tpid = 777\n\tlast exit code = 1\n}\n"
          )
        : {
            code: 113,
            stdout: "",
            stderr: `Could not find service in domain`,
          }
    if (verb === "bootstrap") {
      agentLoaded = true
      return ok()
    }
    if (verb === "bootout") {
      agentLoaded = false
      return ok()
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` }
  }
  let stopHandler: (() => void) | undefined
  let nextPid = 1000
  let now = 0

  const listening = (port: number) => {
    const foreign = options.foreign?.[port]
    if (foreign !== undefined) return foreign
    const proc = procs.find((p) => p.alive && p.spec.port === port)
    return proc === undefined ? "" : `p${proc.pid}\ncnode\n`
  }

  const tailscale = (args: readonly string[]): RunResult => {
    const line = args.join(" ")
    tailscaleCalls.push(line)
    if (options.tailscaleDown === true)
      return {
        code: 1,
        stdout: "",
        stderr: "failed to connect to local tailscaled",
      }
    if (line === "status --json") return ok(fixture("status"))
    if (line === "serve status --json" || line === "funnel status --json")
      return ok(JSON.stringify(serve))
    const [, , https, setPath, target] = args
    if (
      args[0] === "serve" &&
      https !== undefined &&
      setPath !== undefined &&
      target !== undefined
    ) {
      const port = https.replace("--https=", "")
      serve.TCP = { ...serve.TCP, [port]: { HTTPS: true } }
      const web = (serve.Web ??= {})
      const handlers = ((web[`${HOST}:${port}`] ??= {}).Handlers ??= {})
      handlers[setPath.replace("--set-path=", "")] = { Proxy: target }
      return ok()
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${line}` }
  }

  const deps: Deps = {
    platform: "darwin",
    env: options.env ?? { EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN },
    home: "/home/u",
    repoRoot: "/repo",
    nodePath: "/bin/node",
    uid: "uid" in options ? options.uid : 501,
    exec: (command, args) => {
      if (command === "launchctl") return Promise.resolve(launchctl(args))
      if (command === "lsof") {
        const port = Number(args[1]?.replace("-iTCP:", ""))
        const stdout = listening(port)
        return Promise.resolve({
          code: stdout === "" ? 1 : 0,
          stdout,
          stderr: "",
        })
      }
      if (command === "ps") {
        const proc = procs.find((p) => p.alive && String(p.pid) === args.at(-1))
        return Promise.resolve(
          proc === undefined
            ? { code: 1, stdout: "", stderr: "" }
            : ok(`/bin/node ${proc.spec.args.join(" ")}\n`)
        )
      }
      if (command === "tailscale") return Promise.resolve(tailscale(args))
      if (command === "security" && args[0] === "show-keychain-info")
        return Promise.resolve(ok())
      if (command === LLAMA_BIN && args[0] === "--version")
        return Promise.resolve({
          code: 0,
          stdout: "",
          stderr: "version: 0.5.0-dev (build 11149, commit d2e54583c)",
        })
      return Promise.resolve({ code: 127, stdout: "", stderr: `no ${command}` })
    },
    build: () => {
      builds++
      return Promise.resolve(options.buildCode ?? 0)
    },
    launch: (spec, launchOptions) => {
      let exit: (code: number | null) => void = () => undefined
      const exited = new Promise<number | null>((resolve) => {
        exit = resolve
      })
      const proc: Proc = {
        spec,
        options: launchOptions,
        pid: nextPid++,
        alive: true,
        exit,
      }
      proc.exit = (code) => {
        proc.alive = false
        exit(code)
      }
      procs.push(proc)
      if (spec.name === options.failToStart) proc.exit(1)
      else if (spec.name === "gate")
        files.set(`${RUN}/gate-data-plane.sock`, "")
      return { pid: proc.pid, exited }
    },
    fetch: (url) => {
      if (url === "http://127.0.0.1:8080/health")
        return Promise.resolve(new Response(null, { status: 200 }))
      const proc = procs.find((p) => p.alive && p.spec.healthUrl === url)
      return proc === undefined
        ? Promise.reject(new Error("ECONNREFUSED"))
        : Promise.resolve(
            new Response(null, { status: proc.spec.name === "web" ? 204 : 200 })
          )
    },
    clock: {
      now: () => now,
      sleep: (ms) => {
        now += ms
        return Promise.resolve()
      },
    },
    signalGroup: (pid) => {
      procs.find((p) => p.pid === pid && p.alive)?.exit(null)
    },
    groupAlive: (pid) => procs.some((p) => p.pid === pid && p.alive),
    files: {
      exists: (path) => files.has(path),
      read: (path) => files.get(path),
      write: (path, text) => {
        files.set(path, text)
        stats.set(path, { isFile: true, mode: 0o100600, size: text.length })
      },
      remove: (path) => files.delete(path),
      ensurePrivateDir: (path) => dirs.push(path),
      stat: (path) => stats.get(path),
      setMode: () => undefined,
    },
    nodeVersion: "v24.3.0",
    sha256: () =>
      Promise.resolve(
        "3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d"
      ),
    interactive: (command, args, runOptions) => {
      interactive.push({ command, args, options: runOptions })
      return Promise.resolve(0)
    },
    ask: () => Promise.resolve(""),
    onStopSignal: (handler) => {
      stopHandler = handler
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  }
  return {
    deps,
    procs,
    files,
    stats,
    interactive,
    dirs,
    out,
    err,
    serve,
    tailscaleCalls,
    launchctlCalls,
    agentLoaded: () => agentLoaded,
    builds: () => builds,
    stop: () => stopHandler?.(),
    hasStopHandler: () => stopHandler !== undefined,
  }
}
