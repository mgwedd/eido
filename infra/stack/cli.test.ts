import { describe, expect, it } from "vitest"

import type { ServeConfig } from "../tailscale/serve-routes.ts"
import { gateScriptArgs, main, parseArgs } from "./cli.ts"

import {
  HOST,
  STACK,
  RUN,
  SETTINGS,
  KEYCHAIN,
  SECRET,
  fixture,
  world,
} from "./test-support.ts"

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
    expect(parseArgs(["install", "--background"])).toBeUndefined()
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
    // Once for doctor's check, once for the host.
    expect(w.tailscaleCalls).toEqual(["status --json", "status --json"])
  })

  it("starts nothing when the serve routes cannot go in place", async () => {
    const w = world({ serve: JSON.parse(fixture("funnel-on")) as ServeConfig })
    expect(await main(["dev"], w.deps)).toBe(1)
    expect(w.err.at(-1)).toMatch(
      /^Nothing was started: the serve routes are not in place/
    )
    expect(w.procs).toEqual([])
  })

  it("says how to go on when tailscale is not running, and starts nothing", async () => {
    const w = world({ tailscaleDown: true })
    expect(await main(["dev"], w.deps)).toBe(1)
    expect(w.err).toEqual([
      "FAIL tailscale: tailscale status failed: failed to connect to local tailscaled",
      "     fix: open -a Tailscale",
      "Nothing was started. Run pnpm stack:doctor for every check, or pnpm stack:setup.",
    ])
    expect(w.procs).toEqual([])
  })

  it("stops on a doctor failure before anything else, naming its fix", async () => {
    const w = world()
    w.stats.delete(KEYCHAIN)
    expect(await main(["prod", "--no-serve", "--background"], w.deps)).toBe(1)
    expect(w.err).toEqual([
      `FAIL keychain: no keychain at ${KEYCHAIN}`,
      "     fix: pnpm stack:setup",
      "Nothing was started. Run pnpm stack:doctor for every check, or pnpm stack:setup.",
    ])
    expect(w.builds()).toBe(0)
  })

  it("uses EIDO_TAILNET_HOST without asking tailscale for the host", async () => {
    const w = world({
      env: {
        EIDO_TAILNET_HOST: "other.example.ts.net",
        EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN,
      },
    })
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
    expect([...w.files.keys()].filter((k) => k.endsWith(".pid"))).toEqual([])
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
    expect(w.out.at(-2)).toBe(`url: https://${HOST}:8443/`)
    expect(w.out.at(-1)).toBe(
      "login agent: not installed (pnpm stack:install starts the stack at login)"
    )
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
      "login agent: not installed (pnpm stack:install starts the stack at login)",
    ])
  })

  it("reports a loaded agent from launchctl print, and a plist without a loaded job", async () => {
    const loaded = world({ agentLoaded: true })
    loaded.files.set(PLIST, "<plist/>")
    await main(["status", "--no-serve"], loaded.deps)
    expect(loaded.out.at(-1)).toBe(
      "login agent: loaded (running, pid 777, runs 2, last exit 1)"
    )
    const orphan = world({ agentLoaded: true })
    await main(["status", "--no-serve"], orphan.deps)
    expect(orphan.out.at(-1)).toBe(
      "login agent: loaded (running, pid 777, runs 2, last exit 1); its plist is gone, so pnpm stack:uninstall it"
    )
    const unloaded = world()
    unloaded.files.set(PLIST, "<plist/>")
    await main(["status", "--no-serve"], unloaded.deps)
    expect(unloaded.out.at(-1)).toBe(
      "login agent: installed but not loaded; pnpm stack:install loads it"
    )
  })

  it("does not ask launchctl off macOS", async () => {
    const w = world()
    w.deps.platform = "linux"
    await main(["status", "--no-serve"], w.deps)
    expect(w.out.at(-1)).toBe(
      "login agent: launchd only; not on this platform yet (#455)"
    )
    expect(w.launchctlCalls).toEqual([])
  })
})

const PLIST = "/home/u/Library/LaunchAgents/com.eido.stack.plist"

describe("install and uninstall", () => {
  it("writes the plist with PATH and EIDO_STACK_DIR, then bootstraps it", async () => {
    const w = world({
      env: {
        EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN,
        PATH: "/opt/homebrew/bin:/usr/bin",
        EIDO_STACK_DIR: STACK,
        EIDO_GMAIL_CLIENT_ID: "not.passed.example.invalid",
      },
    })
    expect(await main(["install"], w.deps)).toBe(0)
    expect(w.launchctlCalls).toEqual([
      "print gui/501/com.eido.stack",
      `bootstrap gui/501 ${PLIST}`,
    ])
    const plist = w.files.get(PLIST) ?? ""
    expect(plist).toContain(
      "<string>/repo/infra/stack/supervisor-main.ts</string>\n    <string>--start-stack</string>"
    )
    expect(plist).toContain(
      `<key>EIDO_STACK_DIR</key>\n    <string>${STACK}</string>\n    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin</string>\n  </dict>`
    )
    expect(plist).not.toContain("EIDO_GMAIL_CLIENT_ID")
    expect(w.dirs).toContain("/home/u/Library/Logs/eido-dev")
    expect(w.out[0]).toBe(`ok: gui/501/com.eido.stack loaded from ${PLIST}`)
  })

  it("boots a loaded agent out before loading it again", async () => {
    const w = world({ agentLoaded: true })
    expect(await main(["install"], w.deps)).toBe(0)
    expect(w.launchctlCalls).toEqual([
      "print gui/501/com.eido.stack",
      "bootout gui/501/com.eido.stack",
      `bootstrap gui/501 ${PLIST}`,
    ])
  })

  it("reports a failed bootstrap", async () => {
    const w = world({ launchctlFails: "bootstrap" })
    expect(await main(["install"], w.deps)).toBe(1)
    expect(w.err).toEqual([
      "FAIL: launchctl bootstrap: bootstrap failed: Input/output error",
    ])
  })

  it("boots the agent out and removes the plist, and leaves the stack running", async () => {
    const w = world({ agentLoaded: true })
    w.files.set(PLIST, "<plist/>")
    await main(["dev", "--background"], w.deps)
    expect(await main(["uninstall"], w.deps)).toBe(0)
    expect(w.agentLoaded()).toBe(false)
    expect(w.files.has(PLIST)).toBe(false)
    expect(w.procs.every((p) => p.alive)).toBe(true)
    expect(w.out.at(-1)).toBe(
      "The stack's processes keep running; stop them with pnpm stack:stop."
    )
  })

  it("removes a plist whose job is not loaded, and reports a failed bootout", async () => {
    const stale = world()
    stale.files.set(PLIST, "<plist/>")
    expect(await main(["uninstall"], stale.deps)).toBe(0)
    expect(stale.launchctlCalls).toEqual(["print gui/501/com.eido.stack"])
    expect(stale.files.has(PLIST)).toBe(false)
    const failing = world({ agentLoaded: true, launchctlFails: "bootout" })
    failing.files.set(PLIST, "<plist/>")
    expect(await main(["uninstall"], failing.deps)).toBe(1)
    expect(failing.files.has(PLIST)).toBe(true)
  })

  it("refuses off macOS and without a user id", async () => {
    const windows = world()
    windows.deps.platform = "win32"
    expect(await main(["install"], windows.deps)).toBe(1)
    expect(windows.err).toEqual([
      "FAIL: stack install needs launchd and is macOS only so far; Task Scheduler on Windows is #455",
    ])
    const noUid = world({ uid: undefined })
    expect(await main(["uninstall"], noUid.deps)).toBe(1)
    expect(noUid.launchctlCalls).toEqual([])
  })
})

describe("stop with the agent loaded", () => {
  it("says the agent starts the stack again and how to stop that", async () => {
    const w = world({ agentLoaded: true })
    await main(["dev", "--background"], w.deps)
    expect(await main(["stop"], w.deps)).toBe(0)
    expect(w.procs.some((p) => p.alive)).toBe(false)
    expect(w.out.at(-1)).toBe(
      "The login agent is loaded: it starts the stack again at the next login or supervisor restart. To stop that, pnpm stack:uninstall."
    )
  })
})

describe("boot", () => {
  it("starts prod in the background when nothing runs", async () => {
    const w = world()
    expect(await main(["boot"], w.deps)).toBe(0)
    expect(w.builds()).toBe(1)
    expect(w.procs.map((p) => [p.spec.name, p.options.background])).toEqual([
      ["gate", true],
      ["core", true],
      ["web", true],
    ])
    expect(w.procs[0]?.spec.args.join(" ")).not.toContain("--watch")
  })

  it("leaves a running stack alone", async () => {
    const w = world()
    await main(["prod", "--background"], w.deps)
    const core = w.procs.find((p) => p.spec.name === "core")
    core?.exit(0)
    w.out.length = 0
    expect(await main(["boot"], w.deps)).toBe(0)
    expect(w.out).toEqual([
      "boot: gate, web already running; the stack is left as it is",
    ])
    expect(w.procs).toHaveLength(3)
  })

  it("fails when the start fails", async () => {
    const w = world({ buildCode: 2 })
    expect(await main(["boot"], w.deps)).toBe(1)
    expect(w.procs).toEqual([])
  })
})

const FILLED = [
  `EIDO_GATE_KEYCHAIN_PATH=${"'"}${KEYCHAIN}${"'"}`,
  "EIDO_PUSH_VAPID_SUBJECT=mailto:owner@example.invalid",
  "EIDO_GMAIL_CLIENT_ID=send.example.invalid",
  "EIDO_GMAIL_READ_CLIENT_ID=read.example.invalid",
  "",
].join("\n")

const gateOf = (w: ReturnType<typeof world>) =>
  w.procs.find((p) => p.spec.name === "gate")

describe("stack.env", () => {
  it("starts the gate with the keychain, push and Gmail settings from the file alone", async () => {
    const w = world({ env: {}, settings: { text: FILLED } })
    expect(await main(["prod", "--background"], w.deps)).toBe(0)
    expect(gateOf(w)?.spec.env).toMatchObject({
      EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN,
      EIDO_PUSH_VAPID_SUBJECT: "mailto:owner@example.invalid",
      EIDO_GMAIL_CLIENT_ID: "send.example.invalid",
      EIDO_GMAIL_READ_CLIENT_ID: "read.example.invalid",
    })
    expect(w.out).toContain(`Open https://${HOST}:8443/`)
  })

  it("lets an environment variable win over the same key in the file", async () => {
    const w = world({
      env: { EIDO_GMAIL_CLIENT_ID: "from-env.example.invalid" },
      settings: { text: FILLED },
    })
    expect(await main(["prod", "--no-serve", "--background"], w.deps)).toBe(0)
    expect(gateOf(w)?.spec.env["EIDO_GMAIL_CLIENT_ID"]).toBe(
      "from-env.example.invalid"
    )
    expect(gateOf(w)?.spec.env["EIDO_GMAIL_READ_CLIENT_ID"]).toBe(
      "read.example.invalid"
    )
  })

  it("fails on an unknown key, naming it, and starts nothing", async () => {
    const w = world({ settings: { text: "EIDO_BRIDGE_PASSWORD=hunter2\n" } })
    expect(await main(["dev", "--background"], w.deps)).toBe(1)
    expect(w.err).toEqual([
      `FAIL: ${SETTINGS}: EIDO_BRIDGE_PASSWORD is not a stack setting`,
    ])
    expect(w.procs).toEqual([])
  })

  it("refuses a file that is not mode 0600", async () => {
    const w = world({ settings: { text: FILLED, mode: 0o100644 } })
    expect(await main(["doctor"], w.deps)).toBe(1)
    expect(w.err).toEqual([
      `FAIL: ${SETTINGS} has mode 0644, not 0600; fix with: chmod 600 '${SETTINGS}'`,
    ])
  })
})

describe("doctor", () => {
  it("prints every check and exits 0 with no failures", async () => {
    const w = world()
    expect(await main(["doctor"], w.deps)).toBe(0)
    expect(w.out[0]).toBe("OK   node: node v24.3.0 (>=24)")
    expect(w.out.at(-1)).toBe("doctor: no failures")
    expect(w.out.join("\n")).not.toContain(SECRET)
  })

  it("exits 1 on a failure and prints its fix", async () => {
    const w = world()
    w.files.delete("/repo/node_modules/.modules.yaml")
    w.stats.delete(KEYCHAIN)
    expect(await main(["doctor", "--no-serve"], w.deps)).toBe(1)
    expect(w.out).toContain("FAIL dependencies: node_modules is not installed")
    expect(w.out).toContain("     fix: pnpm install --frozen-lockfile")
    expect(w.out.at(-1)).toBe("doctor: 2 failures")
  })
})

describe("gate", () => {
  it("runs the gate CLI with node and the same sockets, data dir and vault start gives the gate", async () => {
    const started = world({ settings: { text: FILLED } })
    await main(["prod", "--background"], started.deps)
    const w = world({ settings: { text: FILLED } })
    expect(await main(["gate", "connect", "gmail"], w.deps)).toBe(0)
    expect(w.interactive).toEqual([
      {
        command: "/bin/node",
        args: [
          "--disable-warning=ExperimentalWarning",
          "--import",
          "./src/ts-hooks.ts",
          "./src/connect.ts",
          "gmail",
        ],
        options: { cwd: "/repo/packages/gate", env: gateOf(started)?.spec.env },
      },
    ])
    expect(gateOf(started)?.spec.env).toMatchObject({
      EIDO_GATE_CONTROL_SOCKET: `${RUN}/gate-control.sock`,
      EIDO_GATE_DATA_DIR: `${STACK}/gate`,
      EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN,
    })
  })

  it("falls back to localhost when Tailscale is down, and passes its exit code", async () => {
    const w = world({ tailscaleDown: true })
    w.deps.interactive = () => Promise.resolve(3)
    expect(await main(["gate", "passkeys", "list"], w.deps)).toBe(3)
  })

  it("refuses a script that is not a plain node command", () => {
    expect(() => gateScriptArgs(undefined, "connect")).toThrow(
      'packages/gate/package.json has no plain "node ..." script named connect'
    )
    expect(() =>
      gateScriptArgs(
        JSON.stringify({ scripts: { connect: "node a.ts && rm -rf x" } }),
        "connect"
      )
    ).toThrow(/no plain "node \.\.\." script named connect/)
    expect(
      gateScriptArgs(
        JSON.stringify({
          scripts: { "enrol-code": "node ./src/enrol-code.ts" },
        }),
        "enrol-code"
      )
    ).toEqual(["./src/enrol-code.ts"])
  })
})

describe("setup", () => {
  it("creates the keychain on the terminal, writes allowlisted keys and runs doctor", async () => {
    const w = world({ env: {} })
    w.stats.delete(KEYCHAIN)
    w.deps.interactive = (command, args, runOptions) => {
      w.interactive.push({ command, args, options: runOptions })
      if (args[0] === "create-keychain")
        w.stats.set(KEYCHAIN, { isFile: true, mode: 0o100600, size: 1 })
      return Promise.resolve(0)
    }
    const code = await main(["setup"], w.deps)
    expect(w.interactive).toEqual([
      {
        command: "security",
        args: ["create-keychain", KEYCHAIN],
        options: undefined,
      },
      {
        command: "security",
        args: ["unlock-keychain", KEYCHAIN],
        options: undefined,
      },
    ])
    expect(
      w.files
        .get(SETTINGS)
        ?.split("\n")
        .filter((l) => /^[A-Z]/.test(l))
    ).toEqual([`EIDO_GATE_KEYCHAIN_PATH=${KEYCHAIN}`])
    expect(w.out).toContain(`OK   keychain: ${KEYCHAIN} is unlocked, mode 0600`)
    expect(w.out.at(-1)).toBe("doctor: no failures")
    expect(code).toBe(0)
  })

  it("parses setup, doctor and gate", () => {
    expect(parseArgs(["setup"])).toEqual({
      command: "setup",
      flags: { serve: true, background: false },
    })
    expect(parseArgs(["setup", "--no-serve"])).toBeUndefined()
    expect(parseArgs(["doctor", "--no-serve"])).toEqual({
      command: "doctor",
      flags: { serve: false, background: false },
    })
    expect(parseArgs(["doctor", "--background"])).toBeUndefined()
    expect(parseArgs(["gate", "connect", "gmail"])).toEqual({
      command: "gate",
      script: "connect",
      args: ["gmail"],
    })
    expect(parseArgs(["gate", "rm"])).toBeUndefined()
  })
})
