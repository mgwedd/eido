import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import type { ServeConfig } from "../tailscale/serve-routes.ts"
import { main, parseArgs, type Deps, type LaunchOptions } from "./cli.ts"
import type { ProcessSpec } from "./config.ts"
import type { RunResult } from "./ports.ts"

const HOST = "node.example.ts.net"
const STACK = "/home/u/Library/Application Support/eido-dev"
const RUN = `${STACK}/run`

const fixture = (name: string) =>
  readFileSync(
    new URL(`../tailscale/fixtures/${name}.json`, import.meta.url),
    "utf8"
  )
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" })

type Proc = {
  spec: ProcessSpec
  options: LaunchOptions
  pid: number
  alive: boolean
  exit: (code: number | null) => void
}

/**
 * A stand-in for the machine: launched processes listen on their port and answer their health
 * check, lsof and ps report them, signals end them, and tailscale keeps a serve config.
 */
function world(
  options: {
    env?: Deps["env"]
    serve?: ServeConfig
    foreign?: Record<number, string>
    failToStart?: string
    buildCode?: number
    tailscaleDown?: boolean
  } = {}
) {
  const procs: Proc[] = []
  const files = new Map<string, string>()
  const dirs: string[] = []
  const out: string[] = []
  const err: string[] = []
  const tailscaleCalls: string[] = []
  const serve: ServeConfig = structuredClone(options.serve ?? {})
  let builds = 0
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
    env: options.env ?? {},
    home: "/home/u",
    repoRoot: "/repo",
    nodePath: "/bin/node",
    exec: (command, args) => {
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
      write: (path, text) => files.set(path, text),
      remove: (path) => files.delete(path),
      ensurePrivateDir: (path) => dirs.push(path),
    },
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
    dirs,
    out,
    err,
    serve,
    tailscaleCalls,
    builds: () => builds,
    stop: () => stopHandler?.(),
    hasStopHandler: () => stopHandler !== undefined,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("parseArgs", () => {
  it("reads the command and flags", () => {
    expect(parseArgs(["dev"])).toEqual({
      command: "dev",
      flags: { serve: true, background: false },
    })
    expect(parseArgs(["prod", "--no-serve", "--background"])).toEqual({
      command: "prod",
      flags: { serve: false, background: true },
    })
    expect(parseArgs(["status", "--no-serve"])).toEqual({
      command: "status",
      flags: { serve: false, background: false },
    })
  })

  it("refuses an unknown command or flag, and --background outside start", () => {
    expect(parseArgs([])).toBeUndefined()
    expect(parseArgs(["restart"])).toBeUndefined()
    expect(parseArgs(["dev", "--watch"])).toBeUndefined()
    expect(parseArgs(["stop", "--background"])).toBeUndefined()
  })

  it("prints usage and exits 2 on bad arguments", async () => {
    const w = world()
    expect(await main(["nope"], w.deps)).toBe(2)
    expect(w.err[0]).toMatch(/^usage: stack dev\|prod\|stop\|status/)
  })
})

describe("start", () => {
  it("applies the serve routes, then starts gate, core and web in order", async () => {
    const w = world({
      serve: JSON.parse(fixture("other-app-only")) as ServeConfig,
    })
    const before443 = JSON.stringify(w.serve.Web?.[`${HOST}:443`])

    expect(await main(["dev", "--background"], w.deps)).toBe(0)

    expect(w.procs.map((p) => p.spec.name)).toEqual(["gate", "core", "web"])
    expect(w.procs.every((p) => p.alive)).toBe(true)
    expect(w.serve.Web?.[`${HOST}:8443`]?.Handlers).toEqual({
      "/": { Proxy: "http://127.0.0.1:3000" },
      "/api/core": { Proxy: "http://127.0.0.1:8789" },
      "/api/gate": { Proxy: "http://127.0.0.1:8788" },
    })
    expect(JSON.stringify(w.serve.Web?.[`${HOST}:443`])).toBe(before443)
    // The host comes from tailscale status, never from the config.
    expect(w.procs[0]?.spec.env["EIDO_WEBAUTHN_RP_ID"]).toBe(HOST)
    expect(w.out).toContain(`Open https://${HOST}:8443/`)
    expect(w.out).toContain(
      "Running in the background. Stop with: pnpm stack:stop"
    )
  })

  it("routes serve output under a prefix", async () => {
    const w = world()
    await main(["dev", "--background"], w.deps)
    expect(
      w.out.filter((l) => l.startsWith("serve | $ tailscale serve"))
    ).toHaveLength(3)
  })

  it("writes a pid file per process and makes the private dirs first", async () => {
    const w = world()
    await main(["dev", "--no-serve", "--background"], w.deps)
    for (const proc of w.procs)
      expect(
        JSON.parse(w.files.get(`${RUN}/${proc.spec.name}.pid`) ?? "")
      ).toEqual({
        name: proc.spec.name,
        pid: proc.pid,
        marker: proc.spec.marker,
        mode: "dev",
      })
    expect(w.dirs).toContain(RUN)
    expect(w.procs[0]?.options).toEqual({
      logFile: "/home/u/Library/Logs/eido-dev/gate.log",
      background: true,
      prefixOutput: false,
    })
  })

  it("skips tailscale entirely with --no-serve", async () => {
    const w = world()
    expect(await main(["dev", "--no-serve", "--background"], w.deps)).toBe(0)
    expect(w.tailscaleCalls).toEqual([])
    expect(w.procs[0]?.spec.env["EIDO_WEBAUTHN_RP_ID"]).toBe("localhost")
    expect(w.out).toContain(
      "Backends only (--no-serve): no serve routes, so the UI does not work from the tailnet origin."
    )
  })

  it("stops before anything starts when a port is in use, naming the holder", async () => {
    const w = world({ foreign: { 3000: "p5695\ncnode\n" } })
    expect(await main(["dev"], w.deps)).toBe(1)
    expect(w.err).toEqual([
      "FAIL: port 3000 (web) is in use by pid 5695 (node); stop it or set EIDO_WEB_PORT",
      "Nothing was started.",
    ])
    expect(w.procs).toEqual([])
    expect(w.tailscaleCalls).toEqual(["status --json"])
  })

  it("starts nothing when the serve routes cannot go in place", async () => {
    const w = world({ serve: JSON.parse(fixture("funnel-on")) as ServeConfig })
    expect(await main(["dev"], w.deps)).toBe(1)
    expect(w.err.at(-1)).toMatch(
      /^Nothing was started: the serve routes are not in place/
    )
    expect(w.procs).toEqual([])
  })

  it("says how to go on when tailscale is not running", async () => {
    const w = world({ tailscaleDown: true })
    expect(await main(["dev"], w.deps)).toBe(1)
    expect(w.err[0]).toMatch(/tailscale status --json failed: .*Use --no-serve/)
  })

  it("uses EIDO_TAILNET_HOST without asking tailscale for the host", async () => {
    const w = world({ env: { EIDO_TAILNET_HOST: "other.example.ts.net" } })
    await main(["dev", "--no-serve", "--background"], w.deps)
    expect(w.procs[2]?.spec.env).toEqual({
      EIDO_TAILNET_HOST: "other.example.ts.net",
    })
  })

  it("builds before a prod start and runs no watchers", async () => {
    const w = world()
    expect(await main(["prod", "--no-serve", "--background"], w.deps)).toBe(0)
    expect(w.builds()).toBe(1)
    expect(w.procs.flatMap((p) => p.spec.args)).not.toContain("--watch")
    expect(w.procs[2]?.spec.args[1]).toBe("start")
  })

  it("starts nothing when the prod build fails", async () => {
    const w = world({ buildCode: 2 })
    expect(await main(["prod", "--no-serve", "--background"], w.deps)).toBe(1)
    expect(w.err).toEqual([
      "FAIL: the build exited with code 2; nothing was started.",
    ])
    expect(w.procs).toEqual([])
  })

  it("stops what started when a later process fails", async () => {
    const w = world({ failToStart: "core" })
    expect(await main(["dev", "--no-serve", "--background"], w.deps)).toBe(1)
    expect(w.err).toEqual([
      "FAIL: core exited with code 1 before it answered; see /home/u/Library/Logs/eido-dev/core.log",
    ])
    expect(w.procs.map((p) => [p.spec.name, p.alive])).toEqual([
      ["gate", false],
      ["core", false],
    ])
    expect(w.out).toContain("gate: stopped (pid 1000)")
    expect([...w.files.keys()].filter((k) => k.endsWith(".pid"))).toEqual([])
  })
})

describe("foreground", () => {
  it("prefixes output in dev and stops all three on Ctrl-C", async () => {
    const w = world()
    const run = main(["dev", "--no-serve"], w.deps)
    while (!w.hasStopHandler()) await settle()
    expect(w.procs.map((p) => p.options.prefixOutput)).toEqual([
      true,
      true,
      true,
    ])
    w.stop()
    expect(await run).toBe(0)
    expect(w.out.slice(-4)).toEqual([
      "Stopping...",
      "web: stopped (pid 1002)",
      "core: stopped (pid 1001)",
      "gate: stopped (pid 1000)",
    ])
    expect(w.procs.some((p) => p.alive)).toBe(false)
  })

  it("does not prefix output in prod", async () => {
    const w = world()
    const run = main(["prod", "--no-serve"], w.deps)
    while (!w.hasStopHandler()) await settle()
    expect(w.procs.map((p) => p.options.prefixOutput)).toEqual([
      false,
      false,
      false,
    ])
    w.stop()
    expect(await run).toBe(0)
  })

  it("stops the rest and exits 1 when one process exits", async () => {
    const w = world()
    const run = main(["dev", "--no-serve"], w.deps)
    while (!w.hasStopHandler()) await settle()
    w.procs[1]?.exit(1)
    expect(await run).toBe(1)
    expect(w.err).toContain("core exited with code 1; stopping the rest")
    expect(w.procs.some((p) => p.alive)).toBe(false)
  })
})

describe("stop", () => {
  it("stops from the pid files and confirms the ports are free", async () => {
    const w = world()
    await main(["dev", "--no-serve", "--background"], w.deps)
    w.out.length = 0
    expect(await main(["stop"], w.deps)).toBe(0)
    expect(w.out).toEqual([
      "web: stopped (pid 1002)",
      "core: stopped (pid 1001)",
      "gate: stopped (pid 1000)",
      "Nothing listens on the stack's ports.",
    ])
    expect([...w.files.keys()].filter((k) => k.endsWith(".pid"))).toEqual([])
  })

  it("names a listener it did not start and leaves it alone", async () => {
    const w = world({ foreign: { 3000: "p5695\ncnode\n" } })
    expect(await main(["stop"], w.deps)).toBe(0)
    expect(w.out).toEqual([
      "No stack pid files; nothing to stop.",
      "port 3000 (web) still has a listener the stack did not start: pid 5695 (node); left alone",
    ])
  })

  it("removes an unreadable pid file and a stale one without signalling", async () => {
    const w = world()
    w.files.set(`${RUN}/gate.pid`, "garbage")
    w.files.set(
      `${RUN}/core.pid`,
      JSON.stringify({
        name: "core",
        pid: 4242,
        marker: "src/main.ts",
        mode: "dev",
      })
    )
    expect(await main(["stop"], w.deps)).toBe(0)
    expect(w.out.slice(0, 2)).toEqual([
      "core: was not running (pid 4242)",
      "gate: unreadable pid file removed",
    ])
    expect(w.files.size).toBe(0)
  })
})

describe("status", () => {
  it("exits 0 when all three run and answer and the routes are in place", async () => {
    const w = world()
    await main(["dev", "--background"], w.deps)
    w.out.length = 0
    expect(await main(["status"], w.deps)).toBe(0)
    expect(w.out[0]).toBe(
      "gate: running (pid 1000, dev); 127.0.0.1:8788 listener pid 1000 (node); health answers 200"
    )
    expect(w.out[2]).toBe(
      "web: running (pid 1002, dev); 127.0.0.1:3000 listener pid 1002 (node); health answers 204"
    )
    expect(w.out.at(-1)).toBe(`url: https://${HOST}:8443/`)
  })

  it("exits 1 and says why when nothing runs", async () => {
    const w = world()
    w.files.set(
      `${RUN}/web.pid`,
      JSON.stringify({ name: "web", pid: 4242, marker: "next", mode: "prod" })
    )
    expect(await main(["status", "--no-serve"], w.deps)).toBe(1)
    expect(w.out).toEqual([
      "gate: not started by the stack; 127.0.0.1:8788 nothing listening; health no answer",
      "core: not started by the stack; 127.0.0.1:8789 nothing listening; health no answer",
      "web: stale pid file (pid 4242 is gone); 127.0.0.1:3000 nothing listening; health no answer",
    ])
  })
})
