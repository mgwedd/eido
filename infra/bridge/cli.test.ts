import { describe, expect, it } from "vitest"

import { main, type Deps, type RunResult } from "./cli.ts"

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" })
const fail = (stderr = ""): RunResult => ({ code: 1, stdout: "", stderr })
const BRIDGE = "/Applications/Proton Mail Bridge.app/Contents/MacOS/bridge"
const PLIST = "/Users/example/Library/LaunchAgents/com.eido.proton-bridge.plist"
const PRINT = `\tstate = running\n\truns = 2\n\tpid = 77\n\tlast exit code = 9\n`

function setup(
  options: {
    launchctl?: (args: readonly string[]) => RunResult
    files?: string[]
    env?: Record<string, string>
    greet?: (port: number) => Promise<string>
  } = {}
) {
  const out: string[] = []
  const err: string[] = []
  const calls: string[][] = []
  const files = new Map<string, string>(
    (options.files ?? [BRIDGE]).map((f) => [f, ""])
  )
  const removed: string[] = []
  const dirs: string[] = []
  const deps: Deps = {
    launchctl: (args) => {
      calls.push([...args])
      return Promise.resolve((options.launchctl ?? (() => ok()))(args))
    },
    readGreeting: (_h, port) =>
      (options.greet ?? (() => Promise.resolve("* OK ready\r\n")))(port),
    fs: {
      exists: (p) => files.has(p),
      mkdir: (p) => void dirs.push(p),
      writeFile: (p, t) => void files.set(p, t),
      remove: (p) => {
        files.delete(p)
        removed.push(p)
      },
    },
    env: options.env ?? {},
    home: "/Users/example",
    uid: 501,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  }
  return { deps, out, err, calls, files, removed, dirs }
}

describe("plan", () => {
  it("prints the plist and the bootstrap command and changes nothing", async () => {
    const t = setup()
    expect(await main(["plan"], t.deps)).toBe(0)
    expect(t.out.join("\n")).toContain(`launchctl bootstrap gui/501 ${PLIST}`)
    expect(t.calls).toEqual([])
    expect(t.files.has(PLIST)).toBe(false)
  })
})

describe("install", () => {
  it("writes the plist, makes the log directory and bootstraps", async () => {
    const t = setup({ launchctl: (a) => (a[0] === "print" ? fail() : ok()) })
    expect(await main(["install"], t.deps)).toBe(0)
    expect(t.files.get(PLIST)).toContain("<string>--noninteractive</string>")
    expect(t.dirs).toEqual(["/Users/example/Library/Logs/eido"])
    expect(t.calls).toEqual([
      ["print", "gui/501/com.eido.proton-bridge"],
      ["bootstrap", "gui/501", PLIST],
    ])
  })
  it("boots out a loaded job before bootstrapping again", async () => {
    const t = setup()
    await main(["install"], t.deps)
    expect(t.calls.map((c) => c[0])).toEqual(["print", "bootout", "bootstrap"])
  })
  it("uses the path given with --bridge", async () => {
    const t = setup({ files: ["/opt/bridge"], launchctl: () => fail() })
    // print fails (not loaded) and bootstrap fails too: only the plist content matters here
    await main(["install", "--bridge", "/opt/bridge"], t.deps)
    expect(t.files.get(PLIST)).toContain("<string>/opt/bridge</string>")
  })
  it("refuses when Bridge is not installed, writing nothing", async () => {
    const t = setup({ files: [] })
    expect(await main(["install"], t.deps)).toBe(1)
    expect(t.err[0]).toContain(`no Bridge at ${BRIDGE}`)
    expect(t.calls).toEqual([])
  })
  it("reports a bootstrap failure", async () => {
    const t = setup({
      launchctl: (a) =>
        a[0] === "print" ? fail() : fail("Bootstrap failed: 5"),
    })
    expect(await main(["install"], t.deps)).toBe(1)
    expect(t.err[0]).toContain("Bootstrap failed: 5")
  })
  it("rejects --bridge without a path", async () => {
    const t = setup()
    expect(await main(["install", "--bridge"], t.deps)).toBe(2)
  })
})

describe("uninstall", () => {
  it("boots out the job and removes the plist", async () => {
    const t = setup({ files: [PLIST] })
    expect(await main(["uninstall"], t.deps)).toBe(0)
    expect(t.calls.map((c) => c[0])).toEqual(["print", "bootout"])
    expect(t.removed).toEqual([PLIST])
  })
  it("succeeds when nothing is loaded or installed", async () => {
    const t = setup({ files: [], launchctl: () => fail() })
    expect(await main(["uninstall"], t.deps)).toBe(0)
    expect(t.calls.map((c) => c[0])).toEqual(["print"])
    expect(t.removed).toEqual([])
  })
  it("fails and keeps the plist when bootout fails", async () => {
    const t = setup({
      files: [PLIST],
      launchctl: (a) => (a[0] === "bootout" ? fail("busy") : ok()),
    })
    expect(await main(["uninstall"], t.deps)).toBe(1)
    expect(t.removed).toEqual([])
  })
})

describe("status", () => {
  it("prints the job fields and exits 0 while running", async () => {
    const t = setup({ launchctl: () => ok(PRINT) })
    expect(await main(["status"], t.deps)).toBe(0)
    expect(t.out).toEqual([
      "state: running",
      "pid: 77",
      "runs: 2",
      "last exit: 9",
    ])
  })
  it("exits 1 when the job is loaded but not running", async () => {
    const t = setup({ launchctl: () => ok("\tstate = waiting\n") })
    expect(await main(["status"], t.deps)).toBe(1)
    expect(t.out).toContain("state: waiting")
  })
  it("exits 1 when the job is not loaded", async () => {
    const t = setup({ launchctl: () => fail() })
    expect(await main(["status"], t.deps)).toBe(1)
    expect(t.err[0]).toContain("is not loaded")
  })
})

describe("health", () => {
  const env = {
    EIDO_BRIDGE_HOST: "127.0.0.1",
    EIDO_BRIDGE_IMAP_PORT: "2143",
    EIDO_BRIDGE_SMTP_PORT: "2025",
  }
  const greet = (port: number) =>
    Promise.resolve(port === 2143 ? "* OK hi\r\n" : "220 hi\r\n")

  it("passes when both ports greet", async () => {
    const t = setup({ env, greet })
    expect(await main(["health"], t.deps)).toBe(0)
    expect(t.out).toEqual([
      "ok: imap 127.0.0.1:2143 greeted",
      "ok: smtp 127.0.0.1:2025 greeted",
    ])
  })
  it("fails and names the dead port while the other still passes", async () => {
    const t = setup({
      env,
      greet: (port) =>
        port === 2025 ? Promise.reject(new Error("ECONNREFUSED")) : greet(port),
    })
    expect(await main(["health"], t.deps)).toBe(1)
    expect(t.out).toEqual(["ok: imap 127.0.0.1:2143 greeted"])
    expect(t.err).toEqual(["FAIL: smtp 127.0.0.1:2025: ECONNREFUSED"])
  })
  it("fails with the variable name when the config is missing", async () => {
    const t = setup({ env: {} })
    expect(await main(["health"], t.deps)).toBe(1)
    expect(t.err[0]).toContain("EIDO_BRIDGE_HOST")
  })
  it("fails with the variable name when a port is missing", async () => {
    const t = setup({ env: { EIDO_BRIDGE_HOST: "::1" } })
    expect(await main(["health"], t.deps)).toBe(1)
    expect(t.err[0]).toContain("EIDO_BRIDGE_IMAP_PORT")
  })
})

describe("usage", () => {
  it("prints usage for an unknown command", async () => {
    const t = setup()
    expect(await main(["nope"], t.deps)).toBe(2)
    expect(t.err[0]).toContain("usage: bridge")
  })
})
