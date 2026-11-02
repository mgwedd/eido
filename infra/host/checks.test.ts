import { describe, expect, it } from "vitest"

import {
  fileVaultFinding,
  loopbackOnlyFinding,
  parseListeners,
  tailscaleFinding,
} from "./checks.ts"

describe("fileVaultFinding", () => {
  it("passes when FileVault is on", () => {
    expect(fileVaultFinding("FileVault is On.\n")).toEqual({
      ok: true,
      message: "FileVault: FileVault is On.",
    })
  })

  it("fails when FileVault is off", () => {
    expect(fileVaultFinding("FileVault is Off.\n")).toEqual({
      ok: false,
      message: 'FileVault is not on: "FileVault is Off."',
    })
  })

  it("fails while encryption is still in progress", () => {
    expect(
      fileVaultFinding("Encryption in progress: Percent completed = 40\n").ok
    ).toBe(false)
  })
})

describe("tailscaleFinding", () => {
  it("passes when the backend is running and names the node", () => {
    expect(
      tailscaleFinding(
        JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "node.example.ts.net." },
        })
      )
    ).toEqual({
      ok: true,
      message: "Tailscale: Running as node.example.ts.net",
    })
  })

  it("passes without a DNS name", () => {
    expect(
      tailscaleFinding(JSON.stringify({ BackendState: "Running" }))
    ).toEqual({
      ok: true,
      message: "Tailscale: Running",
    })
  })

  it("fails when stopped", () => {
    expect(
      tailscaleFinding(JSON.stringify({ BackendState: "Stopped" }))
    ).toEqual({
      ok: false,
      message: 'Tailscale is not running: BackendState "Stopped"',
    })
  })

  it("fails on output that is not JSON or not an object", () => {
    expect(tailscaleFinding("oops").message).toBe(
      "tailscale status --json printed no JSON"
    )
    expect(tailscaleFinding("[]").message).toBe(
      "Tailscale is not running: BackendState null"
    )
  })
})

// `lsof -nP -iTCP:8080 -sTCP:LISTEN -Fpcn`, one process with an IPv4 and IPv6 socket.
const LSOF =
  "p101\ncllama-server\nf3\nn127.0.0.1:8080\nf4\nn127.0.0.1:8080\np202\ncother\nf5\nn*:8080\nf6\nn[::1]:8080\n"

describe("parseListeners", () => {
  it("lists each process and address once", () => {
    expect(parseListeners(LSOF)).toEqual([
      { pid: 101, command: "llama-server", address: "127.0.0.1" },
      { pid: 202, command: "other", address: "*" },
      { pid: 202, command: "other", address: "[::1]" },
    ])
  })
})

describe("loopbackOnlyFinding", () => {
  it("passes when every listener is on loopback", () => {
    expect(
      loopbackOnlyFinding(8080, [
        { pid: 1, command: "llama-server", address: "127.0.0.1" },
        { pid: 1, command: "llama-server", address: "[::1]" },
      ])
    ).toEqual({
      ok: true,
      message:
        "port 8080 listens on loopback only: llama-server (pid 1) on 127.0.0.1, llama-server (pid 1) on [::1]",
    })
  })

  it("fails on a wildcard bind and names it", () => {
    expect(loopbackOnlyFinding(8080, parseListeners(LSOF))).toEqual({
      ok: false,
      message: "port 8080 is reachable beyond loopback: other (pid 202) on *",
    })
  })

  it("fails on a LAN address", () => {
    expect(
      loopbackOnlyFinding(8080, [
        { pid: 3, command: "x", address: "192.168.1.5" },
      ]).ok
    ).toBe(false)
  })

  it("fails when nothing listens", () => {
    expect(loopbackOnlyFinding(8080, [])).toEqual({
      ok: false,
      message: "nothing listens on port 8080",
    })
  })
})
