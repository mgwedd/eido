import { describe, expect, it } from "vitest"

import {
  busyPorts,
  describeListeners,
  listenersOn,
  lsofArgs,
  parseLsof,
  parseNetstat,
  type Exec,
} from "./ports.ts"

/** An lsof stand-in that answers from a map of port to `-Fpc` output. */
function fakeLsof(
  byPort: Record<number, string>,
  stderr = ""
): { exec: Exec; calls: string[][] } {
  const calls: string[][] = []
  const exec: Exec = (command, args) => {
    calls.push([command, ...args])
    const port = Number(args.find((a) => a.startsWith("-iTCP:"))?.slice(6))
    const stdout = byPort[port] ?? ""
    return Promise.resolve({ code: stdout === "" ? 1 : 0, stdout, stderr })
  }
  return { exec, calls }
}

describe("parseLsof", () => {
  it("reads a pid and its command per process", () => {
    expect(parseLsof("p5695\ncnode\np42\ncnext-server\n")).toEqual([
      { pid: 5695, command: "node" },
      { pid: 42, command: "next-server" },
    ])
  })

  it("keeps a pid without a command and skips bad pids", () => {
    expect(parseLsof("pabc\np7\nf12\n")).toEqual([{ pid: 7, command: "" }])
    expect(parseLsof("")).toEqual([])
  })
})

describe("listenersOn", () => {
  it("asks lsof for TCP listeners on the port in field mode", async () => {
    const lsof = fakeLsof({ 3000: "p5695\ncnode\n" })
    expect(await listenersOn(lsof.exec, 3000, "darwin")).toEqual([
      { pid: 5695, command: "node" },
    ])
    expect(lsof.calls).toEqual([["lsof", ...lsofArgs(3000)]])
    expect(lsofArgs(3000)).toEqual([
      "-nP",
      "-iTCP:3000",
      "-sTCP:LISTEN",
      "-Fpc",
    ])
  })

  it("reads exit 1 with no output as no listeners", async () => {
    expect(await listenersOn(fakeLsof({}).exec, 3000, "darwin")).toEqual([])
  })

  it("throws when lsof fails with an error", async () => {
    await expect(
      listenersOn(fakeLsof({}, "lsof: not found").exec, 3000, "darwin")
    ).rejects.toThrow("lsof failed: lsof: not found")
  })
})

describe("busyPorts", () => {
  const ports = [
    { name: "gate", port: 8788, variable: "EIDO_GATE_PHONE_PORT" },
    { name: "core", port: 8789, variable: "EIDO_CORE_PORT" },
    { name: "web", port: 3000, variable: "EIDO_WEB_PORT" },
  ]

  it("is empty when every port is free", async () => {
    expect(await busyPorts(fakeLsof({}).exec, ports, "darwin")).toEqual([])
  })

  it("names the port, its process and the holder (a turbo dev Next on *:3000)", async () => {
    const lsof = fakeLsof({ 3000: "p5695\ncnode\n" })
    expect(await busyPorts(lsof.exec, ports, "darwin")).toEqual([
      "port 3000 (web) is in use by pid 5695 (node); stop it or set EIDO_WEB_PORT",
    ])
  })

  it("reports every busy port and every holder", async () => {
    const lsof = fakeLsof({ 8788: "p1\ncnode\np2\n", 8789: "p3\ncnode\n" })
    expect(await busyPorts(lsof.exec, ports, "darwin")).toEqual([
      "port 8788 (gate) is in use by pid 1 (node), pid 2; stop it or set EIDO_GATE_PHONE_PORT",
      "port 8789 (core) is in use by pid 3 (node); stop it or set EIDO_CORE_PORT",
    ])
  })
})

const NETSTAT = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4120",
  "  TCP    127.0.0.1:30000        0.0.0.0:0              LISTENING       77",
  "  TCP    [::]:3000              [::]:0                 LISTENING       4120",
  "  TCP    127.0.0.1:8788         0.0.0.0:0              LISTENING       5100",
  "  TCP    127.0.0.1:52011        127.0.0.1:3000         ESTABLISHED     900",
  "  UDP    0.0.0.0:3000           *:*                                    12",
  "",
].join("\r\n")

describe("parseNetstat", () => {
  it("finds each pid LISTENING on the port, on IPv4 and IPv6, once", () => {
    expect(parseNetstat(NETSTAT, 3000)).toEqual([{ pid: 4120, command: "" }])
  })

  it("ignores other ports, connections and UDP", () => {
    expect(parseNetstat(NETSTAT, 8789)).toEqual([])
    expect(parseNetstat(NETSTAT, 52011)).toEqual([])
  })
})

describe("listenersOn on Windows", () => {
  it("asks netstat instead of lsof", async () => {
    const calls: string[][] = []
    const exec: Exec = (command, args) => {
      calls.push([command, ...args])
      return Promise.resolve({ code: 0, stdout: NETSTAT, stderr: "" })
    }
    expect(await listenersOn(exec, 8788, "win32")).toEqual([
      { pid: 5100, command: "" },
    ])
    expect(calls).toEqual([["netstat", "-ano", "-p", "TCP"]])
  })

  it("throws when netstat fails", async () => {
    const exec: Exec = () =>
      Promise.resolve({ code: 1, stdout: "", stderr: "denied" })
    await expect(listenersOn(exec, 3000, "win32")).rejects.toThrow(
      "netstat failed: denied"
    )
  })

  it("lets busyPorts report a Windows holder", async () => {
    const exec: Exec = () =>
      Promise.resolve({ code: 0, stdout: NETSTAT, stderr: "" })
    expect(
      await busyPorts(
        exec,
        [{ name: "web", port: 3000, variable: "EIDO_WEB_PORT" }],
        "win32"
      )
    ).toEqual([
      "port 3000 (web) is in use by pid 4120; stop it or set EIDO_WEB_PORT",
    ])
  })
})

describe("describeListeners", () => {
  it("joins pids and commands", () => {
    expect(
      describeListeners([
        { pid: 9, command: "x" },
        { pid: 10, command: "" },
      ])
    ).toBe("pid 9 (x), pid 10")
  })
})
