// Split mode (#779): the owner's stack runs web and the supervisor; the gate and core are the
// plane's LaunchDaemons (infra/host/plane.ts), reported but never started or stopped from here.
import { describe, expect, it } from "vitest"

import { validateStackJobStatus, validateStackError } from "@eido/schemas"

import { main } from "./cli.ts"
import { buildStackConfig, planeOf, type ConfigInput } from "./config.ts"
import {
  describePlaneDaemon,
  planeDaemon,
  planeHealth,
  planePlistPath,
} from "./plane-status.ts"
import type { RunResult } from "./ports.ts"
import { apiSettingProblem } from "./settings.ts"
import { createSupervisor, type SupervisorDeps } from "./supervisor.ts"
import { harness } from "../llama/test-support.ts"
import { KEYCHAIN, RUN, SETTINGS, STACK, world } from "./test-support.ts"

const HOST = "node.example.ts.net"
const SPLIT = { EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN, EIDO_STACK_PLANE: "split" }
const LOGS = "see the log under /Library/Logs/Eido"

const input = (overrides: Partial<ConfigInput> = {}): ConfigInput => ({
  mode: "prod",
  platform: "darwin",
  env: {},
  home: "/home/u",
  repoRoot: "/repo",
  nodePath: "/bin/node",
  tailnetHost: HOST,
  ...overrides,
})

const names = (config: ReturnType<typeof buildStackConfig>) =>
  config.processes.map((spec) => spec.name)

describe("planeOf", () => {
  it("is single when unset or empty, split when asked, and refuses anything else", () => {
    expect(planeOf({})).toBe("single")
    expect(planeOf({ EIDO_STACK_PLANE: "" })).toBe("single")
    expect(planeOf({ EIDO_STACK_PLANE: "split" })).toBe("split")
    expect(() => planeOf({ EIDO_STACK_PLANE: "both" })).toThrow(
      'EIDO_STACK_PLANE must be single or split, not "both"'
    )
  })
})

describe("buildStackConfig in split mode", () => {
  it("returns web and no gate or core process", () => {
    const config = buildStackConfig(input({ plane: "split" }))
    expect(config.plane).toBe("split")
    expect(names(config)).toEqual(["web"])
  })

  it("keeps the gate and core ports, and points web at the gate's", () => {
    const config = buildStackConfig(
      input({ plane: "split", env: { EIDO_GATE_PHONE_PORT: "9100" } })
    )
    expect(config.ports).toEqual({ web: 3000, core: 8789, gate: 9100 })
    expect(config.processes[0]?.env).toEqual({
      EIDO_TAILNET_HOST: HOST,
      EIDO_GATE_PHONE_HOST: "127.0.0.1",
      EIDO_GATE_PHONE_PORT: "9100",
    })
  })

  it("makes no data dir for the plane's gate and core", () => {
    const split = buildStackConfig(input({ plane: "split" }))
    const single = buildStackConfig(input())
    expect(single.privateDirs).toContain(`${STACK}/gate`)
    expect(split.privateDirs).toEqual([
      split.stackDir,
      split.runDir,
      split.logDir,
    ])
  })

  it("refuses off macOS, where there is no plane", () => {
    expect(() =>
      buildStackConfig(input({ plane: "split", platform: "linux" }))
    ).toThrow(
      "EIDO_STACK_PLANE=split needs the macOS plane split (#70); there is none on this platform"
    )
  })

  it("leaves single mode with all three, and gives web no gate address", () => {
    const config = buildStackConfig(input())
    expect(config.plane).toBe("single")
    expect(names(config)).toEqual(["gate", "core", "web"])
    expect(config.processes[2]?.env).toEqual({ EIDO_TAILNET_HOST: HOST })
  })

  it("ignores EIDO_STACK_PLANE in its env: the plane generator still gets the gate and core", () => {
    const config = buildStackConfig(
      input({ env: { EIDO_STACK_PLANE: "split" } })
    )
    expect(names(config)).toEqual(["gate", "core", "web"])
  })
})

describe("EIDO_STACK_PLANE as a setting", () => {
  it("is refused by the settings endpoint, which cannot move the gate", () => {
    expect(apiSettingProblem("EIDO_STACK_PLANE", "split")).toBe(
      "EIDO_STACK_PLANE cannot be changed through the settings endpoint; run the setup command on this machine"
    )
  })

  it("fails the file load on a value that is neither single nor split", async () => {
    const w = world({ settings: { text: "EIDO_STACK_PLANE=both\n" } })
    expect(await main(["status", "--no-serve"], w.deps)).toBe(1)
    expect(w.err).toEqual([
      `FAIL: ${SETTINGS}: EIDO_STACK_PLANE must be single or split, not "both"`,
    ])
  })
})

const run = (code: number, stdout = ""): RunResult => ({
  code,
  stdout,
  stderr: "",
})

describe("planeDaemon", () => {
  const gone = run(113)

  it("asks launchd for the system domain's label", async () => {
    const asked: (readonly string[])[] = []
    await planeDaemon("gate", {
      exec: (_command, args) => {
        asked.push(args)
        return Promise.resolve(gone)
      },
      exists: () => false,
    })
    expect(asked).toEqual([["print", "system/com.eido.plane.gate"]])
  })

  it("reads a running job's pid", async () => {
    const daemon = await planeDaemon("core", {
      exec: () => Promise.resolve(run(0, "\tstate = running\n\tpid = 612\n")),
      exists: () => false,
    })
    expect(daemon).toEqual({ state: "running", pid: 612 })
    expect(describePlaneDaemon("core", daemon)).toBe(
      "com.eido.plane.core is running (pid 612)"
    )
  })

  it("reports a loaded job that is not running with its state and last exit", async () => {
    const daemon = await planeDaemon("gate", {
      exec: () =>
        Promise.resolve(
          run(0, "\tstate = spawn scheduled\n\tlast exit code = 78\n")
        ),
      exists: () => false,
    })
    expect(describePlaneDaemon("gate", daemon)).toBe(
      `com.eido.plane.gate is loaded but not running (state spawn scheduled, last exit code 78); ${LOGS}`
    )
  })

  it("tells a plist that launchd does not know from no plist at all", async () => {
    const probe = (installed: boolean) => ({
      exec: () => Promise.resolve(gone),
      exists: (path: string) =>
        installed &&
        path === "/Library/LaunchDaemons/com.eido.plane.gate.plist",
    })
    expect(planePlistPath("gate")).toBe(
      "/Library/LaunchDaemons/com.eido.plane.gate.plist"
    )
    expect(await planeDaemon("gate", probe(true))).toEqual({
      state: "not-loaded",
    })
    expect(await planeDaemon("gate", probe(false))).toEqual({
      state: "missing",
    })
  })
})

describe("planeHealth", () => {
  const config = buildStackConfig(input({ plane: "split" }))

  it("asks the daemon's health URL on its port and returns the status", async () => {
    const asked: string[] = []
    const status = await planeHealth("core", config, (url) => {
      asked.push(url)
      return Promise.resolve({ status: 503, text: () => Promise.resolve("") })
    })
    expect(asked).toEqual(["http://127.0.0.1:8789/connectors/health"])
    expect(status).toBe(503)
  })

  it("is undefined when nothing answers", async () => {
    expect(
      await planeHealth("gate", config, () =>
        Promise.reject(new Error("ECONNREFUSED"))
      )
    ).toBeUndefined()
  })
})

describe("stack commands in split mode", () => {
  it("prod starts web alone, with the gate's address, and makes no gate or core dir", async () => {
    const w = world({
      env: SPLIT,
      plane: { gate: "running", core: "running" },
    })
    expect(await main(["prod", "--background", "--no-serve"], w.deps)).toBe(0)
    expect(w.procs.map((p) => p.spec.name)).toEqual(["web"])
    expect(w.procs[0]?.spec.env["EIDO_GATE_PHONE_PORT"]).toBe("8788")
    expect(w.dirs).toContain(RUN)
    expect(w.dirs).not.toContain(`${STACK}/gate`)
    expect(w.dirs).not.toContain(`${STACK}/core`)
  })

  it("takes split from stack.env as well as from the environment", async () => {
    const w = world({
      settings: { text: "EIDO_STACK_PLANE=split\n" },
      plane: { gate: "running", core: "running" },
    })
    await main(["prod", "--background", "--no-serve"], w.deps)
    expect(w.procs.map((p) => p.spec.name)).toEqual(["web"])
  })

  it("status reports each plane daemon, its port and health, and exits 1 when one is down", async () => {
    const w = world({
      env: SPLIT,
      plane: { gate: "running", core: "waiting" },
    })
    await main(["prod", "--background", "--no-serve"], w.deps)
    w.out.length = 0
    expect(await main(["status", "--no-serve"], w.deps)).toBe(1)
    expect(w.out.slice(0, 3)).toEqual([
      "gate: com.eido.plane.gate is running (pid 4242); 127.0.0.1:8788 health answers 200",
      `core: com.eido.plane.core is loaded but not running (state waiting, last exit code 78); ${LOGS}; 127.0.0.1:8789 health no answer`,
      "web: running (pid 1000, prod); 127.0.0.1:3000 listener pid 1000 (node); health answers 204",
    ])
  })

  it("status exits 0 when both daemons and web answer", async () => {
    const w = world({
      env: SPLIT,
      plane: { gate: "running", core: "running" },
    })
    await main(["prod", "--background", "--no-serve"], w.deps)
    expect(await main(["status", "--no-serve"], w.deps)).toBe(0)
  })

  it("status says a daemon that is not installed is missing", async () => {
    const w = world({ env: SPLIT, plane: { core: "not-loaded" } })
    await main(["status", "--no-serve"], w.deps)
    expect(w.out[0]).toBe(
      "gate: com.eido.plane.gate is not installed; apply the plane script first (infra/plane-split.md); 127.0.0.1:8788 health no answer"
    )
    expect(w.out[1]).toBe(
      "core: com.eido.plane.core is installed but not loaded; run the plane script again (infra/plane-split.md); 127.0.0.1:8789 health no answer"
    )
  })

  it("stop ends web, leaves the plane's daemons alone and says so", async () => {
    const w = world({
      env: SPLIT,
      plane: { gate: "running", core: "running" },
    })
    await main(["prod", "--background", "--no-serve"], w.deps)
    w.out.length = 0
    expect(await main(["stop"], w.deps)).toBe(0)
    expect(w.procs.every((p) => !p.alive)).toBe(true)
    expect(w.out).toContain(
      "Split mode: the plane's gate and core (com.eido.plane.gate, com.eido.plane.core) are not stopped by this command."
    )
    expect(w.launchctlCalls.every((call) => call.startsWith("print"))).toBe(
      true
    )
  })

  it("stop also ends a gate and core left running from single mode, which would hold the plane's ports", async () => {
    const w = world({ plane: { gate: "running", core: "running" } })
    await main(["prod", "--background", "--no-serve"], w.deps)
    expect(w.procs.map((p) => p.spec.name)).toEqual(["gate", "core", "web"])
    w.out.length = 0
    const split = { ...w.deps, env: { ...w.deps.env, ...SPLIT } }
    expect(await main(["stop"], split)).toBe(0)
    expect(w.out.slice(0, 3)).toEqual([
      "web: stopped (pid 1002)",
      "core: stopped (pid 1001)",
      "gate: stopped (pid 1000)",
    ])
    expect(w.procs.every((p) => !p.alive)).toBe(true)
    expect([...w.files.keys()].filter((k) => k.endsWith(".pid"))).toEqual([])
  })

  it("refuses the commands that act on the owner's own gate", async () => {
    const w = world({ env: SPLIT })
    expect(await main(["gate", "connect", "gmail"], w.deps)).toBe(1)
    expect(await main(["setup"], w.deps)).toBe(1)
    expect(await main(["bootstrap"], w.deps)).toBe(1)
    expect(w.err).toEqual([
      "stack:gate connect acts on the gate under your own account, and EIDO_STACK_PLANE=split puts the gate under _eidogate (infra/plane-split.md). It is not supported in split mode yet (#795).",
      "stack:setup acts on the gate under your own account, and EIDO_STACK_PLANE=split puts the gate under _eidogate (infra/plane-split.md). It is not supported in split mode yet (#795).",
      "stack:bootstrap acts on the gate under your own account, and EIDO_STACK_PLANE=split puts the gate under _eidogate (infra/plane-split.md). It is not supported in split mode yet (#795).",
    ])
    expect(w.interactive).toEqual([])
  })
})

describe("doctor in split mode", () => {
  it("passes both daemons on their state and health URL, and skips the owner's keychain", async () => {
    const w = world({
      env: SPLIT,
      plane: { gate: "running", core: "running" },
    })
    expect(await main(["doctor", "--no-serve"], w.deps)).toBe(0)
    expect(w.out).toContain(
      "OK   ports: com.eido.plane.gate is running (pid 4242); http://127.0.0.1:8788/passkey/status answers 200"
    )
    expect(w.out).toContain(
      "OK   ports: com.eido.plane.core is running (pid 4242); http://127.0.0.1:8789/connectors/health answers 200"
    )
    expect(w.out.some((line) => line.includes(" keychain:"))).toBe(false)
  })

  it("names a daemon that is not installed", async () => {
    const w = world({ env: SPLIT, plane: { core: "running" } })
    expect(await main(["doctor", "--no-serve"], w.deps)).toBe(1)
    expect(w.out).toContain(
      "FAIL ports: com.eido.plane.gate is not installed; apply the plane script first (infra/plane-split.md)"
    )
  })

  it("names a daemon that is loaded but stopped", async () => {
    const w = world({ env: SPLIT, plane: { gate: "running", core: "waiting" } })
    expect(await main(["doctor", "--no-serve"], w.deps)).toBe(1)
    expect(w.out).toContain(
      `FAIL ports: com.eido.plane.core is loaded but not running (state waiting, last exit code 78); ${LOGS}`
    )
  })

  it("names a running daemon whose health URL fails, with the status", async () => {
    const w = world({
      env: SPLIT,
      plane: { gate: "running", core: "running" },
      planeHealth: { gate: 503 },
    })
    expect(await main(["doctor", "--no-serve"], w.deps)).toBe(1)
    expect(w.out).toContain(
      "FAIL ports: com.eido.plane.gate is running (pid 4242); http://127.0.0.1:8788/passkey/status answers 503"
    )
  })

  it("does not stop web from starting when a daemon is down", async () => {
    const w = world({ env: SPLIT, plane: { gate: "running" } })
    expect(await main(["prod", "--background", "--no-serve"], w.deps)).toBe(0)
    expect(w.procs.map((p) => p.spec.name)).toEqual(["web"])
  })

  it("reports no plane checks in single mode", async () => {
    const w = world()
    await main(["doctor", "--no-serve"], w.deps)
    expect(w.out.some((line) => line.includes("com.eido.plane"))).toBe(false)
    expect(w.out.some((line) => line.includes(" keychain:"))).toBe(true)
  })
})

describe("supervisor in split mode", () => {
  function supervise(stack: Parameters<typeof world>[0]) {
    const w = world(stack)
    const h = harness()
    const deps: SupervisorDeps = {
      stack: w.deps,
      llama: h.deps,
      uid: 501,
      pid: 4242,
      writeSettings: () => undefined,
      log: () => undefined,
    }
    return createSupervisor(deps)
  }
  const rows = (reply: { body: unknown }) => {
    const checked = validateStackJobStatus(reply.body)
    if (!checked.ok) throw new Error(checked.errors.join("; "))
    return checked.value.processes
  }

  it("reports the plane's daemons from launchd, neither controllable", async () => {
    const supervisor = supervise({
      env: SPLIT,
      plane: { gate: "running", core: "missing" },
    })
    const processes = rows(await supervisor.handle("GET", "/jobs", ""))
    expect(processes.find((p) => p.name === "gate")).toEqual({
      name: "gate",
      state: "running",
      controllable: false,
    })
    expect(processes.find((p) => p.name === "core")).toEqual({
      name: "core",
      state: "unavailable",
      controllable: false,
      message:
        "com.eido.plane.core is not installed; apply the plane script first (infra/plane-split.md)",
    })
  })

  it("reports a stopped daemon as stopped with the reason", async () => {
    const supervisor = supervise({
      env: SPLIT,
      plane: { gate: "waiting", core: "running" },
    })
    const gate = rows(await supervisor.handle("GET", "/jobs", "")).find(
      (p) => p.name === "gate"
    )
    expect(gate).toEqual({
      name: "gate",
      state: "stopped",
      controllable: false,
      message: `com.eido.plane.gate is loaded but not running (state waiting, last exit code 78); ${LOGS}`,
    })
  })

  it("refuses to start, stop or restart core, which is the plane's", async () => {
    const supervisor = supervise({
      env: SPLIT,
      plane: { gate: "running", core: "running" },
    })
    for (const verb of ["start", "stop", "restart"]) {
      const reply = await supervisor.handle(
        "POST",
        `/jobs/${verb}`,
        JSON.stringify({ names: ["core"] })
      )
      expect(reply.status).toBe(409)
      const checked = validateStackError(reply.body)
      expect(checked.ok && checked.value).toEqual({
        error: "unavailable",
        message:
          "core is the plane's daemon (com.eido.plane.core) in split mode; the stack does not control it",
      })
    }
  })
})
