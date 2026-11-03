import { describe, expect, it } from "vitest"

import { main, type RunResult } from "./cli.ts"

function harness(results: Record<string, RunResult>) {
  const out: string[] = []
  const err: string[] = []
  const calls: string[] = []
  const deps = {
    run: (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(" ")
      calls.push(line)
      return Promise.resolve(
        results[line] ?? { code: 1, stdout: "", stderr: "" }
      )
    },
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
  }
  return { out, err, calls, deps }
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" })

describe("host check", () => {
  it("passes with FileVault on and Tailscale running, running only read commands", async () => {
    const h = harness({
      "fdesetup status": ok("FileVault is On.\n"),
      "tailscale status --json": ok('{"BackendState":"Running"}'),
    })
    expect(await main(["check"], h.deps)).toBe(0)
    expect(h.calls).toEqual(["fdesetup status", "tailscale status --json"])
    expect(h.out).toEqual([
      "ok: FileVault: FileVault is On.",
      "ok: Tailscale: Running",
    ])
  })

  it("fails when either check fails, and says which", async () => {
    const h = harness({
      "fdesetup status": ok("FileVault is Off.\n"),
      "tailscale status --json": {
        code: 1,
        stdout: "",
        stderr: "not running\n",
      },
    })
    expect(await main(["check"], h.deps)).toBe(1)
    expect(h.err).toEqual([
      'FAIL: FileVault is not on: "FileVault is Off."',
      "FAIL: tailscale status --json failed: not running",
    ])
  })

  it("names the exit code when a command prints no error", async () => {
    const h = harness({ "fdesetup status": ok("FileVault is On.\n") })
    expect(await main(["check"], h.deps)).toBe(1)
    expect(h.err).toEqual(["FAIL: tailscale status --json failed: exit 1"])
  })

  it("prints usage for anything but check", async () => {
    const h = harness({})
    expect(await main(["fix"], h.deps)).toBe(2)
    expect(await main(["check", "--x"], h.deps)).toBe(2)
    expect(h.calls).toEqual([])
  })
})
