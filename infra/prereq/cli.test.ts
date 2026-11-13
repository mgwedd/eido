import { describe, expect, it } from "vitest"

import { main, minNodeMajor, type RunResult } from "./cli.ts"

const PACKAGE = JSON.stringify({
  engines: { node: ">=24" },
  packageManager: "pnpm@10.34.7",
})

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" })
const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr })

/** A fake machine: `results` maps a command line to its replies in order; the last repeats. */
function harness(
  results: Record<string, RunResult[]>,
  options: { nodeVersion?: string; packageJson?: string } = {}
) {
  const out: string[] = []
  const err: string[] = []
  const calls: string[] = []
  const seen: Record<string, number> = {}
  const deps = {
    run: (command: string, args: readonly string[]) => {
      const line = [command, ...args].join(" ")
      calls.push(line)
      const replies = results[line] ?? [fail("not found")]
      const index = Math.min(seen[line] ?? 0, replies.length - 1)
      seen[line] = (seen[line] ?? 0) + 1
      return Promise.resolve(replies[index] ?? fail("not found"))
    },
    nodeVersion: options.nodeVersion ?? "24.1.0",
    readPackageJson: () => options.packageJson ?? PACKAGE,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
  }
  return { out, err, calls, deps }
}

describe("minNodeMajor", () => {
  it("reads the major of a >= range", () => {
    expect(minNodeMajor(">=24")).toBe(24)
    expect(minNodeMajor(">= 22.18.0")).toBe(22)
  })
  it("rejects ranges it cannot read", () => {
    expect(minNodeMajor("^24")).toBeUndefined()
    expect(minNodeMajor("")).toBeUndefined()
  })
})

describe("prereq check", () => {
  it("passes and runs nothing but pnpm --version when pnpm resolves", async () => {
    const h = harness({ "pnpm --version": [ok("10.34.7\n")] })
    expect(await main([], h.deps)).toBe(0)
    expect(h.calls).toEqual(["pnpm --version"])
    expect(h.out).toEqual([
      "ok: Node 24.1.0 (needs >=24)",
      "ok: pnpm 10.34.7",
      "Next: pnpm stack:bootstrap",
    ])
  })

  it("enables corepack when pnpm is missing, then confirms pnpm resolves", async () => {
    const h = harness({
      "pnpm --version": [fail("command not found"), ok("10.34.7\n")],
      "corepack enable": [ok("")],
    })
    expect(await main([], h.deps)).toBe(0)
    expect(h.calls).toEqual([
      "pnpm --version",
      "corepack enable",
      "pnpm --version",
    ])
    expect(h.out).toEqual([
      "ok: Node 24.1.0 (needs >=24)",
      "pnpm not found: running corepack enable",
      "ok: pnpm 10.34.7",
      "Next: pnpm stack:bootstrap",
    ])
  })

  it("names the pinned npm install when corepack enable fails", async () => {
    const h = harness({
      "pnpm --version": [fail("command not found")],
      "corepack enable": [fail("EACCES: permission denied")],
    })
    expect(await main([], h.deps)).toBe(1)
    expect(h.calls).toEqual(["pnpm --version", "corepack enable"])
    expect(h.err).toEqual([
      "FAIL: could not make pnpm available through corepack (EACCES: permission denied). Run: npm install --global pnpm@10.34.7, then run this command again.",
    ])
  })

  it("fails when pnpm still does not resolve after corepack enable", async () => {
    const h = harness({
      "pnpm --version": [fail("command not found")],
      "corepack enable": [ok("")],
    })
    expect(await main([], h.deps)).toBe(1)
    expect(h.err[0]).toContain("npm install --global pnpm@10.34.7")
  })

  it("fails on an old Node before touching pnpm, naming the version to install", async () => {
    const h = harness({}, { nodeVersion: "22.9.0" })
    expect(await main([], h.deps)).toBe(1)
    expect(h.calls).toEqual([])
    expect(h.err).toEqual([
      "FAIL: Node 22.9.0 is older than the required >=24. Install Node 24 or newer from https://nodejs.org, then run this command again.",
    ])
  })

  it("compares the major numerically, so Node 100 passes >=24", async () => {
    const h = harness(
      { "pnpm --version": [ok("10.34.7\n")] },
      { nodeVersion: "100.0.0" }
    )
    expect(await main([], h.deps)).toBe(0)
  })

  it("fails when package.json cannot be read for its pins", async () => {
    for (const packageJson of [
      "not json",
      "null",
      "{}",
      JSON.stringify({
        engines: { node: "^24" },
        packageManager: "pnpm@10.0.0",
      }),
      JSON.stringify({ engines: { node: ">=24" }, packageManager: "yarn@4" }),
    ]) {
      const h = harness({}, { packageJson })
      expect(await main([], h.deps)).toBe(1)
      expect(h.err[0]).toContain("run this from the repository root")
      expect(h.calls).toEqual([])
    }
  })

  it("prints usage when given arguments", async () => {
    const h = harness({})
    expect(await main(["--fix"], h.deps)).toBe(2)
    expect(h.err).toEqual(["usage: node infra/prereq/bin.ts"])
    expect(h.calls).toEqual([])
  })
})
