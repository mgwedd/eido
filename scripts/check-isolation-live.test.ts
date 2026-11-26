import { spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import type { Server } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import {
  PROBES,
  attemptKeychainWrite,
  createCanaries,
  createRunDirCanary,
  judge,
  listRunDirFiles,
  openFiles,
  parseArgs,
  parseResult,
  parseSpec,
  probeSudoArgs,
  reachDns,
  reachTcp,
  reachUnixSocket,
  readMatches,
  refusal,
  runLive,
  runProbe,
  safeCode,
  stackPaths,
} from "./check-isolation-live.ts"
import { PARSER_PROBE_NAMES, isParserProbeName } from "./isolation-parser.ts"
import type {
  CanaryHost,
  Canaries,
  LiveConfig,
  LiveRunner,
  ProbeName,
  ProbeResult,
  ProbeSpec,
  Role,
  StackFiles,
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
  parserSocket: "/var/empty/parser-run/parser.sock",
  dataDb: "/var/empty/data/eido-data.db",
  publicHost: "host.example.invalid",
  publicIp: "192.0.2.10",
  timeoutMs: 3000,
}

const CANARIES: Canaries = {
  port: 40001,
  keychainService: "eido-isolation-canary-0011223344556677",
  keychainDigest: "a".repeat(64),
  keychainAddService: "eido-isolation-canary-0011223344556677-add",
  keychainModifyService: "eido-isolation-canary-0011223344556677-modify",
  canaryDb: "/var/empty/gate/.eido-isolation-canary-0011223344556677.db",
  dbDigest: "b".repeat(64),
}

const STACK_CONFIG: LiveConfig = { ...CONFIG, stackDir: "/var/empty/eido-dev" }
const RUN_DIR_FILES: StackFiles = [
  "/var/empty/eido-dev/run/stack.pid",
  "/var/empty/eido-dev/run/.eido-isolation-canary-0011223344556677",
]

const PROBE_SOCKET = "/var/empty/parser-run/probe-00112233445566ff.sock"

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
    stackFilesFail?: boolean
    brokerFails?: boolean
  } = {}
) {
  const calls: Call[] = []
  const stackDirs: string[] = []
  let connections = 0
  let tornDown = 0
  let brokersStarted = 0
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
        (def.subject === "gate" ? def.data === "allowed" : role === "gate") ||
          def.data === "allowed"
          ? REACHED
          : BLOCKED
      )
    },
    stackFiles: (stackDir) => {
      stackDirs.push(stackDir)
      return options.stackFilesFail
        ? Promise.reject(Object.assign(new Error("x"), { code: "EACCES" }))
        : Promise.resolve(RUN_DIR_FILES)
    },
    startParserBroker: () => {
      brokersStarted += 1
      return options.brokerFails
        ? Promise.reject(
            Object.assign(new Error("x"), { code: "BROKER_NOT_READY" })
          )
        : Promise.resolve({ socket: PROBE_SOCKET })
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
  return {
    runner,
    calls,
    stackDirs,
    tornDown: () => tornDown,
    brokersStarted: () => brokersStarted,
  }
}

async function run(
  stub: ReturnType<typeof stubRunner>,
  config: LiveConfig = CONFIG
) {
  const lines: string[] = []
  const code = await runLive(config, stub.runner, (line) => lines.push(line))
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
        "PASS keychain-add (EACCES)",
        "PASS keychain-add.control",
        "PASS keychain-modify (EACCES)",
        "PASS keychain-modify.control",
        "PASS control-db (EACCES)",
        "PASS control-db.control",
        "PASS control-socket (EACCES)",
        "PASS control-socket.control",
        "PASS data-db",
        "PASS parser-socket",
        "PASS parser-loopback (EACCES)",
        "PASS parser-proxy (EACCES)",
        "PASS parser-llama (EACCES)",
        "PASS parser-intent-socket (EACCES)",
        "PASS parser-data-db (EACCES)",
        "SKIP supervisor-socket: no --stack-dir given",
        "SKIP run-dir-files: no --stack-dir given",
      ],
    })
    expect(stub.tornDown()).toBe(1)
    expect(stub.stackDirs).toEqual([])
  })

  describe("with --stack-dir", () => {
    test("passes when the gate user reaches the supervisor socket and is refused every other run dir file", async () => {
      const stub = stubRunner()
      const outcome = await run(stub, STACK_CONFIG)
      expect(outcome.code).toBe(0)
      expect(outcome.lines.slice(-2)).toEqual([
        "PASS supervisor-socket",
        "PASS run-dir-files (EACCES)",
      ])
      expect(stub.stackDirs).toEqual(["/var/empty/eido-dev"])
    })

    test("probes the supervisor socket and the run dir files as the gate user alone, on the right targets", async () => {
      const stub = stubRunner()
      await run(stub, STACK_CONFIG)
      const stackCalls = stub.calls.filter(
        (c) =>
          c.spec.name === "supervisor-socket" || c.spec.name === "run-dir-files"
      )
      expect(stackCalls.map((c) => [c.role, c.spec.name])).toEqual([
        ["gate", "supervisor-socket"],
        ["gate", "run-dir-files"],
      ])
      expect(stackCalls[0]?.spec.path).toBe(
        "/var/empty/eido-dev/run/supervisor/supervisor.sock"
      )
      expect(stackCalls[1]?.spec.paths).toEqual(RUN_DIR_FILES)
    })

    test.each([
      [
        { ran: true, reached: false, code: "ENOENT" },
        "FAIL supervisor-socket: the gate user cannot reach it (ENOENT)",
      ],
      [
        { ran: true, reached: false, code: "EACCES" },
        "FAIL supervisor-socket: the gate user cannot reach it (EACCES)",
      ],
      [
        { ran: false, code: "EXIT_2" },
        "FAIL supervisor-socket: the probe did not run (EXIT_2)",
      ],
    ] satisfies [ProbeResult, string][])(
      "exits 1 when the supervisor socket probe gives %j",
      async (result, line) => {
        const outcome = await run(
          stubRunner((_role, n) =>
            n === "supervisor-socket" ? result : undefined
          ),
          STACK_CONFIG
        )
        expect(outcome.code).toBe(1)
        expect(outcome.lines.filter((l) => l.startsWith("FAIL"))).toEqual([
          line,
        ])
      }
    )

    test.each([
      [REACHED, "FAIL run-dir-files: reached as the gate user"],
      [
        { ran: true, reached: false, code: "ENOENT" },
        "FAIL run-dir-files: refused with ENOENT, not permission denied",
      ],
      [
        { ran: false, code: "NO_FILES" },
        "FAIL run-dir-files: the probe did not run (NO_FILES)",
      ],
    ] satisfies [ProbeResult, string][])(
      "exits 1 when the run dir files probe gives %j",
      async (result, line) => {
        const outcome = await run(
          stubRunner((_role, n) =>
            n === "run-dir-files" ? result : undefined
          ),
          STACK_CONFIG
        )
        expect(outcome.code).toBe(1)
        expect(outcome.lines.filter((l) => l.startsWith("FAIL"))).toEqual([
          line,
        ])
      }
    )

    test("fails the run dir files probe when the run dir cannot be listed, still runs the rest, and tears down", async () => {
      const stub = stubRunner(undefined, { stackFilesFail: true })
      const outcome = await run(stub, STACK_CONFIG)
      expect(outcome.code).toBe(1)
      expect(outcome.lines.filter((l) => l.startsWith("FAIL"))).toEqual([
        "FAIL run-dir-files: the run dir could not be read or given a canary (EACCES)",
      ])
      expect(outcome.lines).toContain("PASS supervisor-socket")
      expect(stub.calls.map((c) => c.spec.name)).not.toContain("run-dir-files")
      expect(stub.tornDown()).toBe(1)
    })

    test("creates no run dir canary when the canaries failed", async () => {
      const stub = stubRunner(undefined, { setupFails: true })
      await run(stub, STACK_CONFIG)
      expect(stub.stackDirs).toEqual([])
    })
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
    expect(target("data", "keychain-add")).toMatchObject({
      keychain: CONFIG.gateKeychain,
      service: CANARIES.keychainAddService,
    })
    expect(target("data", "keychain-modify")).toMatchObject({
      keychain: CONFIG.gateKeychain,
      service: CANARIES.keychainModifyService,
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
    expect(target("data", "data-db")).toMatchObject({ path: CONFIG.dataDb })
    expect(target("data", "parser-socket")).toMatchObject({
      path: CONFIG.parserSocket,
    })
    expect(target("data", "parser-loopback")).toMatchObject({
      host: "127.0.0.1",
      port: 40001,
    })
    expect(target("data", "parser-proxy")).toMatchObject({
      host: "127.0.0.1",
      port: 18080,
    })
    expect(target("data", "parser-llama")).toMatchObject({
      host: "127.0.0.1",
      port: 18081,
    })
    expect(target("data", "parser-intent-socket")).toMatchObject({
      path: CONFIG.intentSocket,
    })
    expect(target("data", "parser-data-db")).toMatchObject({
      path: CONFIG.dataDb,
    })
    expect(
      stub.calls.filter((c) => c.role === "gate").map((c) => c.spec.name)
    ).toEqual([
      "dns",
      "tcp-public",
      "loopback-canary",
      "keychain",
      "keychain-add",
      "keychain-modify",
      "control-db",
      "control-socket",
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
    [
      "keychain-add",
      REACHED,
      "FAIL keychain-add: reached as the data-plane user",
    ],
    [
      "keychain-modify",
      REACHED,
      "FAIL keychain-modify: reached as the data-plane user",
    ],
    ["control-db", REACHED, "FAIL control-db: reached as the data-plane user"],
    [
      "control-socket",
      REACHED,
      "FAIL control-socket: reached as the data-plane user",
    ],
    [
      "parser-loopback",
      REACHED,
      "FAIL parser-loopback: reached from the parse child",
    ],
    [
      "parser-proxy",
      REACHED,
      "FAIL parser-proxy: reached from the parse child",
    ],
    [
      "parser-llama",
      REACHED,
      "FAIL parser-llama: reached from the parse child",
    ],
    [
      "parser-intent-socket",
      REACHED,
      "FAIL parser-intent-socket: reached from the parse child",
    ],
    [
      "parser-data-db",
      REACHED,
      "FAIL parser-data-db: reached from the parse child",
    ],
    [
      "parser-proxy",
      { ran: false, code: "PARSE_CRASHED" },
      "FAIL parser-proxy: the probe did not run (PARSE_CRASHED)",
    ],
    [
      "parser-data-db",
      { ran: true, reached: false, code: "ENOENT" },
      "FAIL parser-data-db: refused with ENOENT, not permission denied",
    ],
    [
      "parser-intent-socket",
      { ran: true, reached: false, code: "ECONNREFUSED" },
      "FAIL parser-intent-socket: refused with ECONNREFUSED, not permission denied",
    ],
    [
      "data-db",
      { ran: true, reached: false, code: "ENOENT" },
      [
        "FAIL data-db: the data-plane user cannot reach an allowed endpoint (ENOENT)",
        "FAIL parser-data-db: data-db did not reach the target as the data-plane user (EACCES), so the probe proves nothing",
      ],
    ],
    [
      "parser-socket",
      { ran: true, reached: false, code: "ENOENT" },
      "FAIL parser-socket: the data-plane user cannot reach an allowed endpoint (ENOENT)",
    ],
    [
      "intent-socket",
      { ran: true, reached: false, code: "ENOENT" },
      [
        "FAIL intent-socket: the data-plane user cannot reach an allowed endpoint (ENOENT)",
        "FAIL parser-intent-socket: intent-socket did not reach the target as the data-plane user (EACCES), so the probe proves nothing",
      ],
    ],
    [
      "proxy",
      { ran: true, reached: false, code: "ECONNREFUSED" },
      [
        "FAIL proxy: the data-plane user cannot reach an allowed endpoint (ECONNREFUSED)",
        "FAIL parser-proxy: proxy did not reach the target as the data-plane user (EACCES), so the probe proves nothing",
      ],
    ],
    [
      "llama",
      { ran: true, reached: false, code: "ETIMEDOUT" },
      [
        "FAIL llama: the data-plane user cannot reach an allowed endpoint (ETIMEDOUT)",
        "FAIL parser-llama: llama did not reach the target as the data-plane user (EACCES), so the probe proves nothing",
      ],
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
  ] satisfies [ProbeName, ProbeResult, string | string[]][])(
    "exits 1 when the data probe %s gives %j",
    async (name, result, expected) => {
      const outcome = await run(
        stubRunner((role, n) =>
          role === "data" && n === name ? result : undefined
        )
      )
      expect(outcome.code).toBe(1)
      expect(outcome.lines.filter((l) => l.startsWith("FAIL"))).toEqual(
        typeof expected === "string" ? [expected] : expected
      )
    }
  )

  test.each([
    "dns",
    "tcp-public",
    "loopback-canary",
    "keychain",
    "keychain-add",
    "keychain-modify",
    "control-db",
    "control-socket",
  ] satisfies ProbeName[])(
    "exits 1 when the %s control fails, since the blocked result then proves nothing",
    async (name) => {
      const outcome = await run(
        stubRunner((role, n) =>
          role === "gate" && n === name ? BLOCKED : undefined
        )
      )
      expect(outcome.code).toBe(1)
      // The broker probe that leans on the loopback canary as its witness fails with it.
      const dependents =
        name === "loopback-canary"
          ? [
              "FAIL parser-loopback: loopback-canary did not reach the target as the gate user (EACCES), so the probe proves nothing",
            ]
          : []
      expect(outcome.lines.filter((l) => l.startsWith("FAIL"))).toEqual([
        `FAIL ${name}.control: the gate user could not do it either (EACCES), so the probe proves nothing`,
        ...dependents,
      ])
    }
  )

  test("starts the probe broker once, before the first broker probe, and sends its socket in every broker spec", async () => {
    const stub = stubRunner()
    await run(stub)
    expect(stub.brokersStarted()).toBe(1)
    const brokerSpecs = stub.calls.filter((c) => isParserProbeName(c.spec.name))
    expect(
      brokerSpecs.map((c) => [c.role, c.spec.name, c.spec.socket])
    ).toEqual([
      ["data", "parser-loopback", PROBE_SOCKET],
      ["data", "parser-proxy", PROBE_SOCKET],
      ["data", "parser-llama", PROBE_SOCKET],
      ["data", "parser-intent-socket", PROBE_SOCKET],
      ["data", "parser-data-db", PROBE_SOCKET],
    ])
    expect(
      stub.calls
        .filter((c) => !isParserProbeName(c.spec.name))
        .every((c) => c.spec.socket === undefined)
    ).toBe(true)
  })

  test("fails once and skips every broker probe when the probe broker does not start, leaving the others to run", async () => {
    const stub = stubRunner(() => undefined, { brokerFails: true })
    const outcome = await run(stub)
    expect(outcome.code).toBe(1)
    expect(outcome.lines.filter((l) => l.startsWith("FAIL"))).toEqual([
      "FAIL parser-broker: the probe broker did not start (BROKER_NOT_READY)",
    ])
    expect(outcome.lines.filter((l) => l.startsWith("SKIP parser-"))).toEqual(
      PARSER_PROBE_NAMES.map(
        (name) => `SKIP ${name}: the probe broker did not start`
      )
    )
    expect(outcome.lines).toContain("PASS data-db")
    expect(stub.brokersStarted()).toBe(1)
    expect(stub.tornDown()).toBe(1)
  })

  test("a blocked broker probe whose witness did not reach proves nothing, and fails", async () => {
    const outcome = await run(
      stubRunner((role, n) =>
        role === "data" && n === "proxy" ? BLOCKED : undefined
      )
    )
    expect(outcome.lines).toContain(
      "FAIL parser-proxy: proxy did not reach the target as the data-plane user (EACCES), so the probe proves nothing"
    )
  })

  test("a witness that did not run is no witness", async () => {
    const outcome = await run(
      stubRunner((role, n) =>
        role === "data" && n === "llama"
          ? { ran: false, code: "EXIT_1" }
          : undefined
      )
    )
    expect(outcome.lines).toContain(
      "FAIL parser-llama: llama did not reach the target as the data-plane user (EACCES), so the probe proves nothing"
    )
  })

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

  test.each(["loopback-canary", "parser-loopback"] satisfies ProbeName[])(
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
    "--parser-socket",
    "/var/empty/parser-run/parser.sock",
    "--data-db",
    "/var/empty/data/eido-data.db",
    "--public-host",
    "host.example.invalid",
    "--public-ip",
    "192.0.2.10",
  ]
  test("reads every flag", () => {
    expect(parseArgs(full)).toEqual({ ok: true, config: CONFIG })
    expect(
      parseArgs([...full, "--data-profile", "/var/empty/core.sb"])
    ).toEqual({
      ok: true,
      config: { ...CONFIG, dataProfile: "/var/empty/core.sb" },
    })
    expect(parseArgs([...full, "--data-profile", "core.sb"])).toEqual({
      ok: false,
      errors: ["the dataProfile path must be absolute"],
    })
    expect(parseArgs([...full, "--stack-dir", "/var/empty/eido-dev"])).toEqual({
      ok: true,
      config: STACK_CONFIG,
    })
    expect(parseArgs([...full, "--stack-dir", "eido-dev"])).toEqual({
      ok: false,
      errors: ["the stackDir path must be absolute"],
    })
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
        "--parser-socket is required",
        "--data-db is required",
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
    expect(parseArgs(set("--parser-socket", "parser.sock"))).toEqual({
      ok: false,
      errors: ["the parserSocket path must be absolute"],
    })
    expect(parseArgs(set("--data-db", "data/eido-data.db"))).toEqual({
      ok: false,
      errors: ["the dataDb path must be absolute"],
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

describe("probeSudoArgs", () => {
  const profiled: LiveConfig = { ...CONFIG, dataProfile: "/var/empty/core.sb" }
  const specOf = (name: ProbeName): ProbeSpec => ({
    name,
    gateUser: CONFIG.gateUser,
    dataUser: CONFIG.dataUser,
    timeoutMs: CONFIG.timeoutMs,
  })
  /** What sudo starts: everything after the `--`. */
  const child = (args: readonly string[]) => args.slice(args.indexOf("--") + 1)
  const sandboxExec = ["/usr/bin/sandbox-exec", "-f", "/var/empty/core.sb"]

  test("starts a data-plane probe under sandbox-exec -f the data profile, as the data user", () => {
    const args = probeSudoArgs("data", specOf("dns"), profiled)
    expect(args.slice(0, 4)).toEqual(["-n", "-u", "eido-data-test", "--"])
    expect(child(args).slice(0, 3)).toEqual(sandboxExec)
    expect(child(args)[3]).toBe(process.execPath)
    expect(child(args).slice(-2)).toEqual([
      "--spec",
      JSON.stringify(specOf("dns")),
    ])
  })
  test("sandboxes every direct data-plane probe, and no broker probe: the broker applies parser.sb", () => {
    for (const def of PROBES.filter((probe) => probe.subject === "data")) {
      const started = child(probeSudoArgs("data", specOf(def.name), profiled))
      expect(started[0] === "/usr/bin/sandbox-exec", def.name).toBe(
        def.via === "direct"
      )
    }
  })
  test("starts a broker probe as the data user with the core hooks and no sandbox-exec", () => {
    const spec = { ...specOf("parser-proxy"), host: "127.0.0.1", port: 18080 }
    const args = probeSudoArgs("data", spec, profiled)
    const started = child(args)
    expect(args.slice(0, 4)).toEqual(["-n", "-u", "eido-data-test", "--"])
    expect(started[0]).toBe(process.execPath)
    expect(args).not.toContain("/usr/bin/sandbox-exec")
    expect(started.slice(1, 3)).toEqual([
      "--disable-warning=ExperimentalWarning",
      "--import",
    ])
    expect(started[3]).toMatch(/packages\/core\/src\/ts-hooks\.ts$/)
    expect(started.slice(-2)).toEqual(["--spec", JSON.stringify(spec)])
  })
  test("never sandboxes a gate-user control and marks it --as-gate", () => {
    for (const def of PROBES.filter((probe) => probe.control)) {
      const args = probeSudoArgs("gate", specOf(def.name), profiled)
      expect(args.slice(0, 4), def.name).toEqual([
        "-n",
        "-u",
        "eido-gate-test",
        "--",
      ])
      expect(child(args)[0], def.name).toBe(process.execPath)
      expect(args.at(-1), def.name).toBe("--as-gate")
    }
  })
  test("starts the gate-user probes as the gate user, unsandboxed and marked --as-gate", () => {
    for (const def of PROBES.filter((probe) => probe.subject === "gate")) {
      const args = probeSudoArgs("gate", specOf(def.name), profiled)
      expect(args.slice(0, 4), def.name).toEqual([
        "-n",
        "-u",
        "eido-gate-test",
        "--",
      ])
      expect(child(args)[0], def.name).toBe(process.execPath)
      expect(args.at(-1), def.name).toBe("--as-gate")
    }
  })
  test("starts nothing under sandbox-exec without a data profile", () => {
    const args = probeSudoArgs("data", specOf("dns"), CONFIG)
    expect(child(args)[0]).toBe(process.execPath)
    expect(args).not.toContain("/usr/bin/sandbox-exec")
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
  test("round-trips the run dir file list and refuses one that is not a list of strings", () => {
    const spec: ProbeSpec = {
      name: "run-dir-files",
      gateUser: "g",
      dataUser: "d",
      timeoutMs: 10,
      paths: ["/a/run/x.pid", "/a/run/y"],
    }
    expect(parseSpec(JSON.stringify(spec))).toEqual(spec)
    expect(
      parseSpec(JSON.stringify({ ...spec, paths: ["/a", 1] }))
    ).toBeUndefined()
    expect(
      parseSpec(JSON.stringify({ ...spec, paths: "/a/run/x.pid" }))
    ).toBeUndefined()
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
})

function fakeHost(failAt?: "listen" | "keychain" | "modify" | "file") {
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
      if (
        failAt === "keychain" ||
        (failAt === "modify" && service.endsWith("-modify"))
      )
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

describe("the stack run dir", () => {
  test("puts the supervisor socket in its own directory below the run dir", () => {
    expect(
      stackPaths("/Users/owner/Library/Application Support/eido-dev")
    ).toEqual({
      runDir: "/Users/owner/Library/Application Support/eido-dev/run",
      supervisorDir:
        "/Users/owner/Library/Application Support/eido-dev/run/supervisor",
      socket:
        "/Users/owner/Library/Application Support/eido-dev/run/supervisor/supervisor.sock",
    })
  })

  describe("on disk", () => {
    let stackDir: string
    beforeAll(() => {
      stackDir = mkdtempSync(join(tmpdir(), "eido-isolation-stack-"))
      const run = join(stackDir, "run")
      mkdirSync(join(run, "supervisor"), { recursive: true })
      mkdirSync(join(run, "nested"))
      writeFileSync(join(run, "stack.pid"), "1")
      writeFileSync(join(run, "nested", "web.pid"), "2")
      writeFileSync(join(run, "supervisor", "supervisor.pid"), "3")
      symlinkSync(join(run, "stack.pid"), join(run, "link.pid"))
    })
    afterAll(() => rmSync(stackDir, { recursive: true, force: true }))

    test("lists the regular files outside the supervisor dir, links and all", () => {
      expect(listRunDirFiles(stackDir).sort()).toEqual([
        join(stackDir, "run", "nested", "web.pid"),
        join(stackDir, "run", "stack.pid"),
      ])
    })

    test("creates a 0600 canary file in the run dir from random bytes, and removes it", () => {
      let n = 0
      const canary = createRunDirCanary(stackDir, (bytes) =>
        Buffer.alloc(bytes, ++n)
      )
      const path = join(
        stackDir,
        "run",
        ".eido-isolation-canary-0101010101010101"
      )
      expect(canary.path).toBe(path)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readFileSync(path)).toEqual(Buffer.alloc(64, 2))
      expect(listRunDirFiles(stackDir)).toContain(path)
      canary.remove()
      expect(existsSync(path)).toBe(false)
    })

    test("refuses to overwrite a file already named like the canary", () => {
      const random = (bytes: number) => Buffer.alloc(bytes, 7)
      const first = createRunDirCanary(stackDir, random)
      try {
        expect(() => createRunDirCanary(stackDir, random)).toThrow()
        expect(existsSync(first.path)).toBe(true)
      } finally {
        first.remove()
      }
    })

    test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "opens a readable file and is refused one it may not open, as permission denied",
      () => {
        const readable = join(stackDir, "run", "stack.pid")
        const locked = join(stackDir, "run", "locked.pid")
        writeFileSync(locked, "synthetic")
        chmodSync(locked, 0o000)
        expect(openFiles([readable])).toEqual(REACHED)
        expect(openFiles([locked])).toEqual({
          ran: true,
          reached: false,
          code: "EACCES",
        })
        // runProbe is what the gate-user child runs: the same answer through the spec.
        return runProbe({
          name: "run-dir-files",
          gateUser: "g",
          dataUser: "d",
          timeoutMs: 100,
          paths: [locked],
        }).then((result) =>
          expect(result).toEqual({ ran: true, reached: false, code: "EACCES" })
        )
      }
    )
  })

  describe("openFiles", () => {
    const deny = (code: string) => () => {
      throw Object.assign(new Error(), { code })
    }
    test("reaches when any file opens, even after refusals", () => {
      const opened: string[] = []
      expect(
        openFiles(["/a", "/b", "/c"], (path) => {
          opened.push(path)
          if (path !== "/b") deny("EACCES")()
        })
      ).toEqual(REACHED)
      expect(opened).toEqual(["/a", "/b"])
    })
    test("is permission denied only when every file was", () => {
      expect(openFiles(["/a", "/b"], deny("EPERM"))).toEqual({
        ran: true,
        reached: false,
        code: "EPERM",
      })
    })
    test("reports a missing file instead of a denial, so a wrong path cannot pass", () => {
      expect(
        openFiles(["/a", "/b"], (path) =>
          deny(path === "/a" ? "EACCES" : "ENOENT")()
        )
      ).toEqual({ ran: true, reached: false, code: "ENOENT" })
    })
    test("does not run with no files to try, since nothing was tested", () => {
      expect(openFiles([], deny("EACCES"))).toEqual({
        ran: false,
        code: "NO_FILES",
      })
    })
  })
})

describe("attemptKeychainWrite", () => {
  const KEYCHAIN = "/var/empty/gate/test.keychain-db"
  const ADD = "eido-isolation-canary-0011223344556677-add"
  const MODIFY = "eido-isolation-canary-0011223344556677-modify"
  const fixed = (bytes: number) => Buffer.alloc(bytes, 0xab)
  const record = () => {
    const calls: (readonly string[])[] = []
    return { calls, run: (args: readonly string[]) => void calls.push(args) }
  }

  test("adds under the new service name without -U, so it can only create", () => {
    const { calls, run } = record()
    expect(attemptKeychainWrite("add", KEYCHAIN, ADD, run, fixed)).toEqual(
      REACHED
    )
    expect(calls).toEqual([
      [
        "add-generic-password",
        "-a",
        ADD,
        "-s",
        ADD,
        "-w",
        "ab".repeat(32),
        KEYCHAIN,
      ],
    ])
  })

  test("modifies the canary with -U, matching it on account and service", () => {
    const { calls, run } = record()
    expect(
      attemptKeychainWrite("modify", KEYCHAIN, MODIFY, run, fixed)
    ).toEqual(REACHED)
    expect(calls).toEqual([
      [
        "add-generic-password",
        "-U",
        "-a",
        MODIFY,
        "-s",
        MODIFY,
        "-w",
        "ab".repeat(32),
        KEYCHAIN,
      ],
    ])
  })

  test("is blocked, with the error code only, when security refuses", () => {
    expect(
      attemptKeychainWrite(
        "add",
        KEYCHAIN,
        ADD,
        () => {
          throw Object.assign(new Error("secret-ish message"), {
            code: "SECURITY_EXIT_1",
          })
        },
        fixed
      )
    ).toEqual({ ran: true, reached: false, code: "SECURITY_EXIT_1" })
  })

  test.each([
    ["add", "login"],
    ["add", "eido-isolation-canary-0011223344556677"],
    ["add", MODIFY],
    ["modify", ADD],
    ["modify", "eido-gate-token"],
    ["modify", "eido-isolation-canary-0011223344556677-modify; x"],
  ] as const)(
    "%s refuses the service name %s without running security, so no real item is touched",
    (mode, service) => {
      const { calls, run } = record()
      expect(attemptKeychainWrite(mode, KEYCHAIN, service, run, fixed)).toEqual(
        {
          ran: false,
          code: "BAD_SERVICE",
        }
      )
      expect(calls).toEqual([])
    }
  )

  test("a probe child given no service name reports a bad spec", async () => {
    expect(
      await runProbe({
        name: "keychain-modify",
        gateUser: "g",
        dataUser: "d",
        timeoutMs: 10,
        keychain: KEYCHAIN,
      })
    ).toEqual({ ran: false, code: "BAD_SPEC" })
  })
})

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
      keychainAddService: "eido-isolation-canary-0101010101010101-add",
      keychainModifyService: "eido-isolation-canary-0101010101010101-modify",
      canaryDb: "/var/empty/gate/.eido-isolation-canary-0101010101010101.db",
      dbDigest:
        "6aa56c4bcd208911792ad24c7681fefb93bed51903afc54860c9bd37e41e5a31",
    })
    expect(JSON.stringify(set.canaries)).not.toContain("02".repeat(32))
    expect(log).toEqual([
      "listen",
      "add eido-isolation-canary-0101010101010101 to /var/empty/gate/test.keychain-db",
      "write /var/empty/gate/.eido-isolation-canary-0101010101010101.db mode 600",
      "add eido-isolation-canary-0101010101010101-modify to /var/empty/gate/test.keychain-db",
    ])
    expect(JSON.stringify(set.canaries)).not.toContain("04".repeat(32))
    expect(await set.cleanup()).toEqual([])
    expect(log.slice(4)).toEqual([
      "delete eido-isolation-canary-0101010101010101-modify from /var/empty/gate/test.keychain-db",
      "delete eido-isolation-canary-0101010101010101-add from /var/empty/gate/test.keychain-db",
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
    expect(await set.cleanup()).toEqual([
      "keychain-modify",
      "keychain-add",
      "keychain",
    ])
    expect(log.slice(4)).toEqual([
      "remove /var/empty/gate/.eido-isolation-canary-0101010101010101.db",
      "close listener",
    ])
  })

  test("undoes everything made so far when the modify canary cannot be added", async () => {
    const { host, log } = fakeHost("modify")
    await expect(createCanaries(spec, host)).rejects.toMatchObject({
      code: "SECURITY_EXIT_51",
      failed: [],
    })
    expect(log.slice(3)).toEqual([
      "delete eido-isolation-canary-0101010101010101-add from /var/empty/gate/test.keychain-db",
      "remove /var/empty/gate/.eido-isolation-canary-0101010101010101.db",
      "delete eido-isolation-canary-0101010101010101 from /var/empty/gate/test.keychain-db",
      "close listener",
    ])
  })

  test("treats an add-probe item that does not exist as already removed, and no other missing item", async () => {
    const { host, log } = fakeHost()
    host.deleteKeychainItem = (_keychain, service) => {
      log.push(`delete ${service}`)
      throw Object.assign(new Error(), { code: "SECURITY_EXIT_44" })
    }
    const set = await createCanaries(spec, host)
    expect(await set.cleanup()).toEqual(["keychain-modify", "keychain"])
  })

  test("reports an add-probe item it could not remove for another reason", async () => {
    const { host } = fakeHost()
    host.deleteKeychainItem = (_keychain, service) => {
      if (service.endsWith("-add"))
        throw Object.assign(new Error(), { code: "SECURITY_EXIT_36" })
    }
    const set = await createCanaries(spec, host)
    expect(await set.cleanup()).toEqual(["keychain-add"])
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

  // The probe child for real, as this user: the data-user path and the --as-gate refusal.
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

  describe.skipIf(process.platform === "win32")(
    "a broker probe through a real probe broker, without the OS fence",
    () => {
      // The probe broker as this user, unsandboxed: the whole delivery path (broker client, socket,
      // broker, parse child, grandchild) runs for real, and only what _eidoparse's sandbox and pf
      // add is missing. So every probe must reach here, which is what the live run's witnesses
      // and a blocked result are measured against.
      const CORE = join(import.meta.dirname, "..", "packages", "core", "src")
      let brokerDir = ""
      let broker: ReturnType<typeof spawn> | undefined
      let socket = ""

      beforeAll(async () => {
        brokerDir = mkdtempSync(join(tmpdir(), "eido-pb-"))
        socket = join(brokerDir, "probe.sock")
        broker = spawn(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            "--import",
            join(CORE, "ts-hooks.ts"),
            "--import",
            join(CORE, "parsers", "no-network.ts"),
            join(import.meta.dirname, "isolation-parser-broker.ts"),
            "--socket",
            socket,
            "--worker",
            join(import.meta.dirname, "isolation-parser-child.ts"),
          ],
          { stdio: ["pipe", "pipe", "inherit"] }
        )
        const stdout = broker.stdout
        if (stdout === null) throw new Error("no broker stdout")
        const line = await new Promise<string>((resolve) =>
          stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()))
        )
        expect(line.trim()).toBe('{"ready":true}')
      }, 30_000)

      afterAll(() => {
        broker?.stdin?.end()
        rmSync(brokerDir, { recursive: true, force: true })
      })

      const viaBroker = async (
        spec: Partial<ProbeSpec> & { name: ProbeName }
      ) => {
        const full: ProbeSpec = {
          gateUser: "eido-gate-test",
          dataUser: me,
          timeoutMs: 2000,
          socket,
          ...spec,
        }
        const proc = spawn(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            "--import",
            join(CORE, "ts-hooks.ts"),
            SCRIPT,
            "probe",
            "--spec",
            JSON.stringify(full),
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        )
        let stdout = ""
        proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
        const status = await new Promise((resolve) =>
          proc.once("close", resolve)
        )
        return { status, result: parseResult(stdout.trim()) }
      }

      test("a parse child with no fence connects to the loopback canary", async () => {
        const before = accepted
        expect(
          await viaBroker({ name: "parser-loopback", host: "127.0.0.1", port })
        ).toEqual({ status: 0, result: REACHED })
        expect(accepted).toBeGreaterThan(before)
      }, 30_000)

      test("a parse child with no fence opens a file, and a missing one is ENOENT", async () => {
        const file = join(dir, "canary.db")
        writeFileSync(file, "synthetic")
        expect(await viaBroker({ name: "parser-data-db", path: file })).toEqual(
          { status: 0, result: REACHED }
        )
        expect(
          await viaBroker({
            name: "parser-data-db",
            path: join(dir, "none.db"),
          })
        ).toEqual({
          status: 0,
          result: { ran: true, reached: false, code: "ENOENT" },
        })
      }, 30_000)

      test("a parse child with no fence reaches a Unix socket, and a missing one is ENOENT", async () => {
        expect(
          await viaBroker({ name: "parser-intent-socket", path: socketPath() })
        ).toEqual({ status: 0, result: REACHED })
        expect(
          await viaBroker({
            name: "parser-intent-socket",
            path: join(dir, "none.sock"),
          })
        ).toEqual({
          status: 0,
          result: { ran: true, reached: false, code: "ENOENT" },
        })
      }, 30_000)

      test("a probe with no socket in its spec reports a bad spec and sends nothing", async () => {
        const before = accepted
        const out = await viaBroker({
          name: "parser-loopback",
          host: "127.0.0.1",
          port,
          socket: undefined,
        })
        expect(out.result).toEqual({ ran: false, code: "BAD_SPEC" })
        expect(accepted).toBe(before)
      }, 30_000)
    }
  )

  test("the run names every missing flag and exits 2 before probing anything", async () => {
    const out = await child([])
    expect(out.status).toBe(2)
    expect(out.stderr).toContain("--gate-user is required")
    expect(out.stdout).toBe("")
  })
})
