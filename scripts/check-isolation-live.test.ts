import { spawn } from "node:child_process"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import type { Server } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import {
  PROBES,
  createCanaries,
  judge,
  parseArgs,
  parseResult,
  parseSpec,
  parserOutcome,
  reachDns,
  reachTcp,
  reachUnixSocket,
  readMatches,
  refusal,
  runLive,
  safeCode,
} from "./check-isolation-live.ts"
import type {
  CanaryHost,
  Canaries,
  LiveConfig,
  LiveRunner,
  ProbeName,
  ProbeResult,
  ProbeSpec,
  Role,
} from "./check-isolation-live.ts"

// The live script's own logic, with a stubbed probe runner: no sudo, no users, no Keychain, no
// pf. The probe functions run for real against listeners and files this test owns.

const CONFIG: LiveConfig = {
  gateUser: "eido-gate-test",
  dataUser: "eido-data-test",
  intentSocket: "/var/empty/intent.sock",
  controlSocket: "/var/empty/control.sock",
  controlDb: "/var/empty/gate/eido-control.db",
  gateKeychain: "/var/empty/gate/test.keychain-db",
  proxyPort: 18080,
  llamaPort: 18081,
  parserProfile: "/var/empty/parser.sb",
  publicHost: "host.example.invalid",
  publicIp: "192.0.2.10",
  timeoutMs: 3000,
}

const CANARIES: Canaries = {
  port: 40001,
  keychainService: "eido-isolation-canary-0011223344556677",
  keychainDigest: "a".repeat(64),
  canaryDb: "/var/empty/gate/.eido-isolation-canary-0011223344556677.db",
  dbDigest: "b".repeat(64),
}

const BLOCKED: ProbeResult = { ran: true, reached: false, code: "EACCES" }
const REACHED: ProbeResult = { ran: true, reached: true, code: "OK" }

type Call = { role: Role; spec: ProbeSpec }

/** A runner whose host is isolated as #70 intends, unless `override` says otherwise. */
function stubRunner(
  override: (role: Role, name: ProbeName) => ProbeResult | undefined = () =>
    undefined,
  options: {
    setupFails?: boolean
    teardownFails?: boolean
    dataTouchesCanary?: ProbeName
  } = {}
) {
  const calls: Call[] = []
  let connections = 0
  let tornDown = 0
  const runner: LiveRunner = {
    setup: () =>
      options.setupFails
        ? Promise.reject(
            Object.assign(new Error("x"), { code: "SECURITY_EXIT_51" })
          )
        : Promise.resolve(CANARIES),
    probe: (role, spec) => {
      calls.push({ role, spec })
      const def = PROBES.find((p) => p.name === spec.name)
      if (def === undefined) throw new Error("unknown probe")
      if (
        def.canaryListener &&
        (role === "gate" || options.dataTouchesCanary === spec.name)
      )
        connections += 1
      const forced = override(role, spec.name)
      if (forced !== undefined) return Promise.resolve(forced)
      return Promise.resolve(
        role === "gate" || def.data === "allowed" ? REACHED : BLOCKED
      )
    },
    connections: () => Promise.resolve(connections),
    teardown: () => {
      tornDown += 1
      return options.teardownFails
        ? Promise.reject(
            Object.assign(new Error("x"), { code: "CANARY_CLEANUP" })
          )
        : Promise.resolve()
    },
  }
  return { runner, calls, tornDown: () => tornDown }
}

async function run(stub: ReturnType<typeof stubRunner>) {
  const lines: string[] = []
  const code = await runLive(CONFIG, stub.runner, (line) => lines.push(line))
  return { code, lines }
}

describe("runLive", () => {
  test("passes a host where every blocked probe is blocked and its control succeeds", async () => {
    const stub = stubRunner()
    expect(await run(stub)).toEqual({
      code: 0,
      lines: [
        "PASS dns (EACCES)",
        "PASS dns.control",
        "PASS tcp-public (EACCES)",
        "PASS tcp-public.control",
        "PASS loopback-canary (EACCES)",
        "PASS loopback-canary.control",
        "PASS intent-socket",
        "PASS proxy",
        "PASS llama",
        "PASS keychain (EACCES)",
        "PASS keychain.control",
        "PASS control-db (EACCES)",
        "PASS control-db.control",
        "PASS control-socket (EACCES)",
        "PASS control-socket.control",
        "PASS parser (EACCES)",
        "PASS parser.control",
      ],
    })
    expect(stub.tornDown()).toBe(1)
  })

  test("runs the data probes as the data user and the controls as the gate user, on the right targets", async () => {
    const stub = stubRunner()
    await run(stub)
    const target = (role: Role, name: ProbeName) =>
      stub.calls.find((c) => c.role === role && c.spec.name === name)?.spec
    expect(target("data", "loopback-canary")).toMatchObject({
      host: "127.0.0.1",
      port: 40001,
    })
    expect(target("data", "tcp-public")).toMatchObject({
      host: "192.0.2.10",
      port: 443,
    })
    expect(target("data", "dns")).toMatchObject({
      host: "host.example.invalid",
    })
    expect(target("data", "proxy")).toMatchObject({
      host: "127.0.0.1",
      port: 18080,
    })
    expect(target("data", "llama")).toMatchObject({
      host: "127.0.0.1",
      port: 18081,
    })
    expect(target("data", "intent-socket")).toMatchObject({
      path: "/var/empty/intent.sock",
    })
    expect(target("data", "control-socket")).toMatchObject({
      path: "/var/empty/control.sock",
    })
    expect(target("data", "control-db")).toMatchObject({
      path: CANARIES.canaryDb,
      digest: CANARIES.dbDigest,
    })
    expect(target("gate", "keychain")).toMatchObject({
      keychain: CONFIG.gateKeychain,
      service: CANARIES.keychainService,
      digest: CANARIES.keychainDigest,
    })
    expect(target("data", "parser")).toMatchObject({
      port: 40001,
      profile: CONFIG.parserProfile,
    })
    expect(
      stub.calls.filter((c) => c.role === "gate").map((c) => c.spec.name)
    ).toEqual([
      "dns",
      "tcp-public",
      "loopback-canary",
      "keychain",
      "control-db",
      "control-socket",
      "parser",
    ])
  })

  test.each([
    ["dns", REACHED, "FAIL dns: reached as the data-plane user"],
    ["tcp-public", REACHED, "FAIL tcp-public: reached as the data-plane user"],
    [
      "loopback-canary",
      REACHED,
      "FAIL loopback-canary: reached as the data-plane user",
    ],
    ["keychain", REACHED, "FAIL keychain: reached as the data-plane user"],
    ["control-db", REACHED, "FAIL control-db: reached as the data-plane user"],
    [
      "control-socket",
      REACHED,
      "FAIL control-socket: reached as the data-plane user",
    ],
    ["parser", REACHED, "FAIL parser: reached as the data-plane user"],
    [
      "intent-socket",
      { ran: true, reached: false, code: "ENOENT" },
      "FAIL intent-socket: the data-plane user cannot reach an allowed endpoint (ENOENT)",
    ],
    [
      "proxy",
      { ran: true, reached: false, code: "ECONNREFUSED" },
      "FAIL proxy: the data-plane user cannot reach an allowed endpoint (ECONNREFUSED)",
    ],
    [
      "llama",
      { ran: true, reached: false, code: "ETIMEDOUT" },
      "FAIL llama: the data-plane user cannot reach an allowed endpoint (ETIMEDOUT)",
    ],
    [
      "dns",
      { ran: false, code: "EXIT_1" },
      "FAIL dns: the probe did not run (EXIT_1)",
    ],
    [
      "control-db",
      { ran: true, reached: false, code: "ENOENT" },
      "FAIL control-db: refused with ENOENT, not permission denied",
    ],
    [
      "control-socket",
      { ran: true, reached: false, code: "ETIMEDOUT" },
      "FAIL control-socket: refused with ETIMEDOUT, not permission denied",
    ],
  ] satisfies [ProbeName, ProbeResult, string][])(
    "exits 1 when the data probe %s gives %j",
    async (name, result, line) => {
      const outcome = await run(
        stubRunner((role, n) =>
          role === "data" && n === name ? result : undefined
        )
      )
      expect(outcome.code).toBe(1)
      expect(outcome.lines.filter((l) => l.startsWith("FAIL"))).toEqual([line])
    }
  )

  test.each([
    "dns",
    "tcp-public",
    "loopback-canary",
    "keychain",
    "control-db",
    "control-socket",
    "parser",
  ] satisfies ProbeName[])(
    "exits 1 when the %s control fails, since the blocked result then proves nothing",
    async (name) => {
      const outcome = await run(
        stubRunner((role, n) =>
          role === "gate" && n === name ? BLOCKED : undefined
        )
      )
      expect(outcome.code).toBe(1)
      expect(outcome.lines.filter((l) => l.startsWith("FAIL"))).toEqual([
        `FAIL ${name}.control: the gate user could not do it either (EACCES), so the probe proves nothing`,
      ])
    }
  )

  test("fails a control that read the wrong content", async () => {
    const outcome = await run(
      stubRunner((role, n) =>
        role === "gate" && n === "control-db"
          ? { ran: true, reached: true, code: "DIGEST_MISMATCH" }
          : undefined
      )
    )
    expect(outcome.lines).toContain(
      "FAIL control-db.control: the gate user could not do it either (DIGEST_MISMATCH), so the probe proves nothing"
    )
    expect(outcome.code).toBe(1)
  })

  test.each(["loopback-canary", "parser"] satisfies ProbeName[])(
    "fails %s when the canary listener saw the data user, whatever the probe reported",
    async (name) => {
      const outcome = await run(
        stubRunner(undefined, { dataTouchesCanary: name })
      )
      expect(outcome.code).toBe(1)
      expect(outcome.lines.filter((l) => l.startsWith("FAIL"))).toEqual([
        `FAIL ${name}: the canary listener saw 1 connection(s)`,
      ])
    }
  )

  test("treats a probe that throws as not run, and still tears down", async () => {
    const stub = stubRunner()
    const probe = stub.runner.probe
    stub.runner.probe = (role, spec) =>
      spec.name === "keychain" && role === "data"
        ? Promise.reject(Object.assign(new Error("boom"), { code: "ENOMEM" }))
        : probe(role, spec)
    const outcome = await run(stub)
    expect(outcome.lines).toContain(
      "FAIL keychain: the probe did not run (ENOMEM)"
    )
    expect(outcome.code).toBe(1)
    expect(stub.tornDown()).toBe(1)
  })

  test("runs no probe when the canaries cannot be created, tears down and exits 1", async () => {
    const stub = stubRunner(undefined, { setupFails: true })
    expect(await run(stub)).toEqual({
      code: 1,
      lines: [
        "FAIL setup: the canaries could not be created (SECURITY_EXIT_51)",
      ],
    })
    expect(stub.calls).toEqual([])
    expect(stub.tornDown()).toBe(1)
  })

  test("exits 1 when a canary could not be removed, even if every probe passed", async () => {
    const outcome = await run(stubRunner(undefined, { teardownFails: true }))
    expect(outcome.code).toBe(1)
    expect(outcome.lines.at(-1)).toBe(
      "FAIL cleanup: a canary may be left behind (CANARY_CLEANUP)"
    )
  })

  test("never prints what a probe returns beyond an error code", async () => {
    const secret = "synthetic-canary-value-4b1d"
    const outcome = await run(
      stubRunner((role, n) =>
        role === "data" && n === "keychain"
          ? { ran: true, reached: true, code: secret }
          : undefined
      )
    )
    expect(outcome.lines.join("\n")).not.toContain(secret)
    expect(outcome.lines).toContain(
      "FAIL keychain: reached as the data-plane user"
    )
  })
})

describe("judge", () => {
  const def = PROBES.find((p) => p.name === "control-db")
  if (def === undefined) throw new Error("no control-db probe")
  test("accepts EPERM as permission denied (a sandbox refusal)", () => {
    expect(
      judge(def, "data", { ran: true, reached: false, code: "EPERM" }, 0)
    ).toBe("PASS control-db (EPERM)")
  })
})

describe("safeCode", () => {
  test.each([
    [{ code: "EACCES" }, "EACCES"],
    ["SECURITY_EXIT_44", "SECURITY_EXIT_44"],
    [{ code: "password: hunter2" }, "error"],
    [{ code: "eacces" }, "error"],
    [new Error("ENOENT: /secret/path"), "error"],
    [undefined, "error"],
  ])("%j -> %s", (value, expected) => {
    expect(safeCode(value)).toBe(expected)
  })
})

describe("refusal", () => {
  const users = { gateUser: "eido-gate-test", dataUser: "eido-data-test" }
  test("refuses a probe as the gate user without --as-gate", () => {
    expect(
      refusal("probe", { user: "eido-gate-test", uid: 501 }, users, false)
    ).toBe(
      "refusing to probe as the gate user without --as-gate: the result would not be the data plane's"
    )
  })
  test("runs the control as the gate user with --as-gate", () => {
    expect(
      refusal("probe", { user: "eido-gate-test", uid: 501 }, users, true)
    ).toBeUndefined()
  })
  test("runs a probe as the data user without --as-gate", () => {
    expect(
      refusal("probe", { user: "eido-data-test", uid: 502 }, users, false)
    ).toBeUndefined()
  })
  test("refuses --as-gate from anyone but the gate user", () => {
    expect(
      refusal("probe", { user: "eido-data-test", uid: 502 }, users, true)
    ).toBe("--as-gate is the positive control and runs as the gate user only")
  })
  test("refuses a probe from a third user", () => {
    expect(refusal("probe", { user: "someone", uid: 503 }, users, false)).toBe(
      "probes run as the data-plane user (or as the gate user with --as-gate)"
    )
  })
  test("refuses the whole run as the gate user, and without root", () => {
    expect(
      refusal("run", { user: "eido-gate-test", uid: 501 }, users, false)
    ).toBe(
      "refusing to run as the gate user: run the whole check with sudo, from an admin account"
    )
    expect(refusal("run", { user: "someone", uid: 503 }, users, false)).toBe(
      "run with sudo: the check starts its probes as each user with sudo -u"
    )
    expect(
      refusal("run", { user: "root", uid: 0 }, users, false)
    ).toBeUndefined()
  })
  test("creates the canaries as the gate user only", () => {
    expect(
      refusal("canaries", { user: "eido-data-test", uid: 502 }, users, false)
    ).toBe("the canaries must be created by the gate user")
    expect(
      refusal("canaries", { user: "eido-gate-test", uid: 501 }, users, false)
    ).toBeUndefined()
  })
})

describe("parseArgs", () => {
  const full = [
    "--gate-user",
    "eido-gate-test",
    "--data-user",
    "eido-data-test",
    "--intent-socket",
    "/var/empty/intent.sock",
    "--control-socket",
    "/var/empty/control.sock",
    "--control-db",
    "/var/empty/gate/eido-control.db",
    "--gate-keychain",
    "/var/empty/gate/test.keychain-db",
    "--proxy-port",
    "18080",
    "--llama-port",
    "18081",
    "--parser-profile",
    "/var/empty/parser.sb",
    "--public-host",
    "host.example.invalid",
    "--public-ip",
    "192.0.2.10",
  ]
  test("reads every flag", () => {
    expect(parseArgs(full)).toEqual({ ok: true, config: CONFIG })
    expect(parseArgs([...full, "--timeout-ms", "500"])).toEqual({
      ok: true,
      config: { ...CONFIG, timeoutMs: 500 },
    })
  })
  test("names every missing flag", () => {
    expect(parseArgs(["--gate-user", "eido-gate-test"])).toEqual({
      ok: false,
      errors: [
        "--data-user is required",
        "--intent-socket is required",
        "--control-socket is required",
        "--control-db is required",
        "--gate-keychain is required",
        "--parser-profile is required",
        "--public-host is required",
        "--public-ip is required",
        "--proxy-port is required",
        "--llama-port is required",
      ],
    })
  })
  test("refuses one user for both planes, relative paths, bad ports and a non-IPv4 address", () => {
    const set = (flag: string, value: string) => {
      const args = [...full]
      args[args.indexOf(flag) + 1] = value
      return args
    }
    expect(parseArgs(set("--data-user", "eido-gate-test"))).toEqual({
      ok: false,
      errors: ["--gate-user and --data-user must be different users"],
    })
    expect(parseArgs(set("--control-db", "gate/eido-control.db"))).toEqual({
      ok: false,
      errors: ["the controlDb path must be absolute"],
    })
    expect(parseArgs(set("--proxy-port", "70000"))).toEqual({
      ok: false,
      errors: ["--proxy-port must be a TCP port"],
    })
    expect(parseArgs(set("--public-ip", "host.example.invalid"))).toEqual({
      ok: false,
      errors: ["--public-ip must be an IPv4 address"],
    })
    expect(parseArgs(set("--gate-user", "Gate User"))).toEqual({
      ok: false,
      errors: ["--gate-user is not a user name"],
    })
    expect(parseArgs([...full, "--as-gate"])).toEqual({
      ok: false,
      errors: ["--as-gate needs a value"],
    })
    expect(parseArgs([...full, "--extra", "1"])).toEqual({
      ok: false,
      errors: ["unknown argument --extra"],
    })
  })
})

describe("parseSpec and parseResult", () => {
  test("round-trips a spec and refuses one with an unknown probe or a bad field", () => {
    const spec: ProbeSpec = {
      name: "proxy",
      gateUser: "g",
      dataUser: "d",
      timeoutMs: 10,
      host: "127.0.0.1",
      port: 1,
    }
    expect(parseSpec(JSON.stringify(spec))).toEqual(spec)
    expect(parseSpec(JSON.stringify({ ...spec, name: "rm" }))).toBeUndefined()
    expect(parseSpec(JSON.stringify({ ...spec, port: "1" }))).toBeUndefined()
    expect(parseSpec("not json")).toBeUndefined()
  })
  test("reads a probe child's line and refuses anything else", () => {
    expect(parseResult('{"ran":true,"reached":false,"code":"EPERM"}')).toEqual({
      ran: true,
      reached: false,
      code: "EPERM",
    })
    expect(parseResult('{"ran":true,"code":"OK"}')).toEqual({
      ran: false,
      code: "BAD_OUTPUT",
    })
    expect(parseResult("PASS")).toEqual({ ran: false, code: "BAD_OUTPUT" })
  })
  test("counts only a connect attempt that connected as reaching the network from the parser", () => {
    const failed = { outcome: "failed", error: "Error" }
    expect(
      parserOutcome({
        attempts: [
          { name: "fetch", ...failed },
          { name: "net.connect", outcome: "connected", error: "" },
          { name: "dns.lookup", ...failed },
        ],
      })
    ).toEqual({ ran: true, reached: true, code: "OK" })
    expect(
      parserOutcome({
        attempts: [
          { name: "fetch", ...failed },
          { name: "net.connect", ...failed },
          { name: "dns.lookup", outcome: "connected", error: "" },
        ],
      })
    ).toEqual({ ran: true, reached: false, code: "BLOCKED" })
    expect(parserOutcome({})).toEqual({ ran: false, code: "NO_RESULT" })
  })
})

function fakeHost(failAt?: "listen" | "keychain" | "file") {
  const log: string[] = []
  let n = 0
  const host: CanaryHost = {
    listen: () => {
      if (failAt === "listen")
        return Promise.reject(
          Object.assign(new Error(), { code: "EADDRINUSE" })
        )
      log.push("listen")
      return Promise.resolve({
        port: 40001,
        connections: () => 0,
        close: () => {
          log.push("close listener")
          return Promise.resolve()
        },
      })
    },
    addKeychainItem: (keychain, service) => {
      if (failAt === "keychain")
        throw Object.assign(new Error(), { code: "SECURITY_EXIT_51" })
      log.push(`add ${service} to ${keychain}`)
    },
    deleteKeychainItem: (keychain, service) =>
      log.push(`delete ${service} from ${keychain}`),
    modeOf: () => 0o100600,
    writeFile: (path, _bytes, mode) => {
      if (failAt === "file")
        throw Object.assign(new Error(), { code: "EACCES" })
      log.push(`write ${path} mode ${mode.toString(8)}`)
    },
    removeFile: (path) => log.push(`remove ${path}`),
    random: (bytes) => Buffer.alloc(bytes, ++n),
  }
  return { host, log }
}

describe("createCanaries", () => {
  const spec = {
    controlDb: "/var/empty/gate/eido-control.db",
    gateKeychain: "/var/empty/gate/test.keychain-db",
  }

  test("creates the canaries with the control DB's mode, returns digests only, and removes them all", async () => {
    const { host, log } = fakeHost()
    const set = await createCanaries(spec, host)
    expect(set.canaries).toEqual({
      port: 40001,
      keychainService: "eido-isolation-canary-0101010101010101",
      // Digests computed with shasum -a 256: of the secret ("02" x 32, its hex text) and of the
      // DB canary's 64 bytes of 0x03. The fake host's random() fills each call with its count.
      keychainDigest:
        "749f1a97ff6cd00ea46ccb3a47bb123283fe56c8fa324bea295d928f558161df",
      canaryDb: "/var/empty/gate/.eido-isolation-canary-0101010101010101.db",
      dbDigest:
        "6aa56c4bcd208911792ad24c7681fefb93bed51903afc54860c9bd37e41e5a31",
    })
    expect(JSON.stringify(set.canaries)).not.toContain("02".repeat(32))
    expect(log).toEqual([
      "listen",
      "add eido-isolation-canary-0101010101010101 to /var/empty/gate/test.keychain-db",
      "write /var/empty/gate/.eido-isolation-canary-0101010101010101.db mode 600",
    ])
    expect(await set.cleanup()).toEqual([])
    expect(log.slice(3)).toEqual([
      "remove /var/empty/gate/.eido-isolation-canary-0101010101010101.db",
      "delete eido-isolation-canary-0101010101010101 from /var/empty/gate/test.keychain-db",
      "close listener",
    ])
  })

  test("undoes the Keychain item and the listener when the control DB canary cannot be written", async () => {
    const { host, log } = fakeHost("file")
    await expect(createCanaries(spec, host)).rejects.toMatchObject({
      code: "EACCES",
      failed: [],
    })
    expect(log.slice(2)).toEqual([
      "delete eido-isolation-canary-0101010101010101 from /var/empty/gate/test.keychain-db",
      "close listener",
    ])
  })

  test("closes the listener when the Keychain item cannot be added", async () => {
    const { host, log } = fakeHost("keychain")
    await expect(createCanaries(spec, host)).rejects.toMatchObject({
      code: "SECURITY_EXIT_51",
    })
    expect(log).toEqual(["listen", "close listener"])
  })

  test("reports a step it could not undo and still runs the others", async () => {
    const { host, log } = fakeHost()
    host.deleteKeychainItem = () => {
      throw new Error("locked")
    }
    const set = await createCanaries(spec, host)
    expect(await set.cleanup()).toEqual(["keychain"])
    expect(log.slice(3)).toEqual([
      "remove /var/empty/gate/.eido-isolation-canary-0101010101010101.db",
      "close listener",
    ])
  })
})

describe("the probes, against a listener and files this test owns", () => {
  let dir: string
  let tcp: Server
  let unix: Server
  let port = 0
  let accepted = 0
  const socketPath = () => join(dir, "probe.sock")

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "eido-isolation-live-"))
    const accept = (socket: { destroy: () => void }) => {
      accepted += 1
      socket.destroy()
    }
    tcp = createServer(accept)
    unix = createServer(accept)
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve))
    const address = tcp.address()
    port = typeof address === "object" && address !== null ? address.port : 0
    if (process.platform !== "win32")
      await new Promise<void>((resolve) => unix.listen(socketPath(), resolve))
  })

  afterAll(async () => {
    await new Promise((resolve) => tcp.close(resolve))
    if (unix.listening) await new Promise((resolve) => unix.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  test("reaches an open TCP port and is refused by a closed one", async () => {
    expect(await reachTcp("127.0.0.1", port, 2000)).toEqual(REACHED)
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const address = closed.address()
    const closedPort =
      typeof address === "object" && address !== null ? address.port : 0
    await new Promise((resolve) => closed.close(resolve))
    expect(await reachTcp("127.0.0.1", closedPort, 2000)).toEqual({
      ran: true,
      reached: false,
      code: "ECONNREFUSED",
    })
  })

  test.skipIf(process.platform === "win32")(
    "reaches a Unix socket and reports a missing one",
    async () => {
      expect(await reachUnixSocket(socketPath(), 2000)).toEqual(REACHED)
      expect(await reachUnixSocket(join(dir, "none.sock"), 2000)).toEqual({
        ran: true,
        reached: false,
        code: "ENOENT",
      })
    }
  )

  test("reports a resolver failure, success and a hang as their codes", async () => {
    expect(
      await reachDns("h.example.invalid", 2000, () =>
        Promise.reject(Object.assign(new Error(), { code: "ENOTFOUND" }))
      )
    ).toEqual({
      ran: true,
      reached: false,
      code: "ENOTFOUND",
    })
    expect(
      await reachDns("h.example.invalid", 2000, () =>
        Promise.resolve({ address: "192.0.2.1" })
      )
    ).toEqual(REACHED)
    expect(
      await reachDns(
        "h.example.invalid",
        50,
        () => new Promise(() => undefined)
      )
    ).toEqual({
      ran: true,
      reached: false,
      code: "ETIMEDOUT",
    })
  })

  test("matches a readable file by digest, and reports a wrong one", () => {
    const path = join(dir, "canary.db")
    writeFileSync(path, "synthetic canary bytes")
    // sha256("synthetic canary bytes"), computed independently with shasum -a 256.
    const digest =
      "3e0c3f647bb9c13dc2905f6e8d84498adf3d7a43c2c34386f64c8a2c4a719fb6"
    expect(readMatches(() => readFileSync(path), digest)).toEqual(REACHED)
    expect(readMatches(() => readFileSync(path), "0".repeat(64))).toEqual({
      ran: true,
      reached: true,
      code: "DIGEST_MISMATCH",
    })
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports permission denied for a file it may not read",
    () => {
      const path = join(dir, "locked.db")
      writeFileSync(path, "synthetic")
      chmodSync(path, 0o000)
      expect(readMatches(() => readFileSync(path), "0".repeat(64))).toEqual({
        ran: true,
        reached: false,
        code: "EACCES",
      })
    }
  )

  // The probe child for real, as this user: the data-user path, the --as-gate refusal, and the
  // parser control (the #43 hostile fixture without the sandbox, which must connect).
  const SCRIPT = join(import.meta.dirname, "check-isolation-live.ts")
  const me = userInfo().username
  const child = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const proc = spawn(process.execPath, [SCRIPT, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
        proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
        proc.once("close", (status) => resolve({ status, stdout, stderr }))
      }
    )

  test("a probe child as the data user prints its result as one JSON line", async () => {
    const spec: ProbeSpec = {
      name: "loopback-canary",
      gateUser: "eido-gate-test",
      dataUser: me,
      timeoutMs: 2000,
      host: "127.0.0.1",
      port,
    }
    const out = await child(["probe", "--spec", JSON.stringify(spec)])
    expect(out.stderr).not.toContain("SyntaxError")
    expect([out.status, parseResult(out.stdout.trim())]).toEqual([0, REACHED])
  })

  test("a probe child run by the gate user without --as-gate refuses and probes nothing", async () => {
    const before = accepted
    const spec: ProbeSpec = {
      name: "loopback-canary",
      gateUser: me,
      dataUser: "eido-data-test",
      timeoutMs: 2000,
      host: "127.0.0.1",
      port,
    }
    const out = await child(["probe", "--spec", JSON.stringify(spec)])
    expect(out).toEqual({
      status: 2,
      stdout: "",
      stderr:
        "refusing to probe as the gate user without --as-gate: the result would not be the data plane's\n",
    })
    expect(accepted).toBe(before)
  })

  test("the parser control runs the hostile fixture without the sandbox and connects", async () => {
    const before = accepted
    const spec: ProbeSpec = {
      name: "parser",
      gateUser: me,
      dataUser: "eido-data-test",
      timeoutMs: 2000,
      port,
      profile: "/var/empty/parser.sb",
    }
    const out = await child([
      "probe",
      "--spec",
      JSON.stringify(spec),
      "--as-gate",
    ])
    expect([out.status, parseResult(out.stdout.trim())]).toEqual([0, REACHED])
    expect(accepted).toBeGreaterThan(before)
  }, 30_000)

  test("the run names every missing flag and exits 2 before probing anything", async () => {
    const out = await child([])
    expect(out.status).toBe(2)
    expect(out.stderr).toContain("--gate-user is required")
    expect(out.stdout).toBe("")
  })
})
